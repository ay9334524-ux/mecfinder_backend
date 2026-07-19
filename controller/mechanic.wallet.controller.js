const mongoose = require('mongoose');
const Mechanic = require('../models/Mechanic');
const MechanicDebt = require('../models/MechanicDebt');
const MechanicEarning = require('../models/MechanicEarning');
const cashflowSettlementService = require('../services/cashflowSettlement.service');
const razorpayService = require('../services/razorpay.service');
const CompanyLedger = require('../models/CompanyLedger');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');
const { logger } = require('../services/logger.service');
const { clampLimit, clampPage } = require('../utils/pagination');
const AuditLog = require('../models/AuditLog');
const { getMinPayoutInr } = require('../config/minPayoutInr');
const cashLimitPolicyService = require('../services/cashLimitPolicy.service');
const distributedLock = require('../services/distributedLock.service');

/**
 * Get mechanic's wallet & debt summary
 * GET /api/mechanic/wallet/summary
 */
const getWalletSummary = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;

  const [walletBalance, debtSummary, earningDetails] = await Promise.all([
    cashflowSettlementService.getMechanicWalletBalance(mechanicId),
    cashflowSettlementService.getMechanicDebtSummary(mechanicId),
    MechanicEarning.aggregate([
      {
        $match: {
          mechanicId: new mongoose.Types.ObjectId(mechanicId),
          status: { $in: ['AVAILABLE', 'PAID'] },
        },
      },
      {
        $group: {
          _id: null,
          totalEarnings: { $sum: '$netAmount' },
          paidCount: { $sum: 1 },
        },
      },
    ]),
  ]);

  const totalEarnings = earningDetails[0]?.totalEarnings || 0;
  const pendingPayoutReserve = await cashflowSettlementService.getPendingWithdrawalReserveAmount(mechanicId);
  const spendableAfterQueue = walletBalance.balance - pendingPayoutReserve;
  const minPayoutInr = getMinPayoutInr();

  ApiResponse.success(res, {
    wallet: {
      balance: walletBalance.balance,
      /** Same as balance — emphasises ₹100 − ₹75 dues = ₹25 */
      netBalance: walletBalance.balance,
      /** Earnings still ON_HOLD until platform fee cleared (cash jobs) */
      onHoldBalance: walletBalance.onHoldBalance,
      totalEarnings: walletBalance.totalEarnings,
      pendingPayoutReserve,
      spendableBalance: spendableAfterQueue,
      availableForWithdraw: Math.max(0, spendableAfterQueue),
      isNegative: walletBalance.isNegative || walletBalance.balance < 0,
      totalDebt: walletBalance.totalDebt,
      minPayoutAmount: minPayoutInr,
      canRequestPayout:
        walletBalance.totalDebt <= 0
        && spendableAfterQueue >= minPayoutInr,
    },
    debt: debtSummary,
    canBook: (await cashflowSettlementService.canMechanicBook(mechanicId)).canBook,
    bookingRestriction: await cashflowSettlementService.canMechanicBook(mechanicId),
  });
});

/**
 * Get mechanic's earnings history (with debt info)
 * GET /api/mechanic/earnings/history
 */
const getEarningsHistory = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;
  const { status } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 20 });
  const skip = (page - 1) * limit;

  const filter = { mechanicId: new mongoose.Types.ObjectId(mechanicId) };
  if (status) filter.status = status;

  const [earnings, total, debts] = await Promise.all([
    MechanicEarning.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('bookingId', 'bookingId serviceSnapshot pricing'),
    MechanicEarning.countDocuments(filter),
    MechanicDebt.find({ mechanicId: new mongoose.Types.ObjectId(mechanicId) })
      .sort({ createdAt: -1 })
      .limit(10),
  ]);

  // Map earnings with associated debt info
  const earningsWithDebt = earnings.map(earning => ({
    id: earning._id,
    bookingId: earning.bookingId?._id || earning.bookingId,
    bookingCode: earning.bookingCode,
    grossAmount: earning.grossAmount,
    netAmount: earning.netAmount,
    status: earning.status,
    createdAt: earning.createdAt,
    paymentMethod: earning.paymentMethod,
    associatedDebt: debts.find(d => d.bookingId.toString() === earning.bookingId?.toString()),
  }));

  ApiResponse.paginated(res, earningsWithDebt, {
    page,
    limit,
    total,
  });
});

/**
 * Get mechanic's detailed debt information
 * GET /api/mechanic/debt/details
 */
const getDebtDetails = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;

  const debtSummary = await cashflowSettlementService.getMechanicDebtSummary(mechanicId);
  const bookingEligibility = await cashflowSettlementService.canMechanicBook(mechanicId);

  ApiResponse.success(res, {
    summary: debtSummary,
    bookingRestriction: bookingEligibility,
    totalOutstanding: debtSummary.totalDebt,
    overdueAmount: debtSummary.overdueAmount,
    message: !bookingEligibility.canBook 
      ? bookingEligibility.message 
      : 'No debt - you can book new jobs',
  });
});

/**
 * Simulate mechanic wallet for testing
 * GET /api/mechanic/wallet/test
 */
const getTestWallet = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;

  const earnings = await MechanicEarning.find({
    mechanicId: new mongoose.Types.ObjectId(mechanicId),
  }).select('bookingCode netAmount paymentMethod status').sort({ createdAt: -1 }).limit(10);

  const debts = await MechanicDebt.find({
    mechanicId: new mongoose.Types.ObjectId(mechanicId),
  }).select('bookingId debtAmount status').sort({ createdAt: -1 }).limit(10);

  const walletBalance = await cashflowSettlementService.getMechanicWalletBalance(mechanicId);

  ApiResponse.success(res, {
    mechanic: {
      id: mechanicId,
      earnings: earnings.map(e => ({
        booking: e.bookingCode,
        amount: e.netAmount,
        method: e.paymentMethod,
        status: e.status,
      })),
      debts: debts.map(d => ({
        booking: d.bookingId,
        debtAmount: d.debtAmount,
        status: d.status,
        remaining: d.getRemainingBalance(),
      })),
      walletBalance: {
        totalEarnings: walletBalance.totalEarnings,
        totalDebt: walletBalance.totalDebt,
        balance: walletBalance.balance,
        isNegative: walletBalance.isNegative,
      },
    },
  });
});

/**
 * Generate a Razorpay Payment Link for clearing mechanic debt
 * Mechanic opens the link → pays via Google Pay / UPI → webhook auto-confirms
 * POST /api/mechanic/wallet/fine-payment-link
 */
const generateFinePaymentLink = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;
  const mechanic = await Mechanic.findById(mechanicId).select('fullName phone');
  const totalDebtRaw = await MechanicDebt.getTotalActiveDebt(mechanicId);
  const totalDebt = Math.round(Number(totalDebtRaw) * 100) / 100;

  if (totalDebt <= 0) {
    return ApiResponse.badRequest(res, 'You have no active debt to clear');
  }

  if (totalDebt < 1) {
    return ApiResponse.badRequest(res, 'Debt amount too small for online payment');
  }

  const linkResult = await razorpayService.createPaymentLink({
    amount: totalDebt,
    referenceId: `FINE-${mechanicId}-${Date.now()}`,
    description: `MecFinder platform fee ₹${totalDebt}`,
    customer: {
      name: mechanic?.fullName || 'Mechanic',
      contact: mechanic?.phone,
    },
    notes: {
      mechanicId: String(mechanicId),
      purpose: 'FINE_PAYMENT',
      debtAmount: String(totalDebt),
    },
  });

  if (!linkResult.success) {
    await AuditLog.create({
      category: 'PAYMENT_LINK',
      action: 'FINE_LINK_FAILED',
      mechanicId,
      amount: totalDebt,
      status: 'FAILED',
      message: linkResult.error,
    }).catch(() => {});
    return ApiResponse.serverError(res, 'Failed to create payment link: ' + linkResult.error);
  }

  await AuditLog.create({
    category: 'PAYMENT_LINK',
    action: 'FINE_LINK_CREATED',
    mechanicId,
    amount: totalDebt,
    status: 'CREATED',
    meta: { paymentLinkId: linkResult.paymentLink.id },
  }).catch(() => {});

  ApiResponse.success(res, {
    paymentLink: linkResult.paymentLink.short_url,
    paymentLinkId: linkResult.paymentLink.id,
    amount: totalDebt,
  }, 'Fine payment link generated. Open the link to pay via UPI / Google Pay.');
});

/**
 * @deprecated Use generateFinePaymentLink instead
 * POST /api/mechanic/wallet/clear-debt
 */
const createDebtClearanceOrder = asyncHandler(async (req, res) => {
  return generateFinePaymentLink(req, res);
});

/**
 * Sync debt status by manually fetching the latest payment link from Razorpay.
 * Useful for local testing when webhooks cannot reach localhost.
 * GET /api/mechanic/wallet/sync-debt
 */
const syncDebtStatus = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;

  // Find the latest payment link created for this mechanic
  const latestLog = await AuditLog.findOne({
    category: 'PAYMENT_LINK',
    action: 'FINE_LINK_CREATED',
    mechanicId: new mongoose.Types.ObjectId(mechanicId),
    status: 'CREATED',
  }).sort({ createdAt: -1 });

  if (!latestLog || !latestLog.meta?.paymentLinkId) {
    return ApiResponse.success(res, { synced: false }, 'No pending payment links found');
  }

  const paymentLinkId = latestLog.meta.paymentLinkId;
  const linkResult = await razorpayService.fetchPaymentLink(paymentLinkId);

  if (!linkResult.success || !linkResult.paymentLink) {
    return ApiResponse.success(res, { synced: false }, 'Failed to fetch link from Razorpay');
  }

  // If the link is paid, we can settle the debt!
  if (linkResult.paymentLink.status === 'paid' || linkResult.paymentLink.amount_paid >= linkResult.paymentLink.amount) {
    const amountPaid = linkResult.paymentLink.amount_paid;
    
    // Find the successful payment ID if available
    const payments = linkResult.paymentLink.payments || [];
    const successfulPayment = payments.find(p => p.status === 'captured') || payments[0];
    const paymentId = successfulPayment ? successfulPayment.payment_id : paymentLinkId;

    // Settle all active debt
    const settlementResult = await MechanicDebt.settleDebt(
      mechanicId,
      paymentId,
      amountPaid,
      'PAYMENT_LINK_SYNC'
    );

    const actualRemainingDebt = await MechanicDebt.getTotalActiveDebt(mechanicId);

    // Update the log so we don't process it again
    latestLog.status = actualRemainingDebt <= 0 ? 'CLEARED' : 'PARTIAL';
    await latestLog.save();

    // Unblock mechanic if fully cleared
    if (actualRemainingDebt <= 0) {
      await Mechanic.findByIdAndUpdate(mechanicId, { hasActiveDebt: false });
      await cashflowSettlementService.releaseOnHoldEarnings(mechanicId);
    }

    logger.info(`✅ [sync] FINE_PAYMENT synced for mechanic ${mechanicId}, cleared ₹${amountPaid}, remaining ₹${actualRemainingDebt}`);
    
    return ApiResponse.success(res, { 
      synced: true, 
      clearedAmount: amountPaid,
      remainingDebt: actualRemainingDebt
    }, 'Debt status synced successfully');
  }

  return ApiResponse.success(res, { synced: false, status: linkResult.paymentLink.status }, 'Payment link not paid yet');
});

/**
 * Verify debt clearance payment
 * POST /api/mechanic/wallet/verify-debt-payment
 */
const verifyDebtClearancePayment = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  // Verify payment signature — accepts object or positional args
  const verification = razorpayService.verifyPayment(
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  );

  if (!verification.success) {
    return ApiResponse.badRequest(res, 'Payment verification failed');
  }

  const paymentInfo = await razorpayService.getPayment(razorpay_payment_id);
  if (!paymentInfo.success || paymentInfo.payment.status !== 'captured') {
    return ApiResponse.badRequest(res, 'Payment not captured');
  }

  // amount is in INR
  const amountPaid = paymentInfo.payment.amount;

  // Settle debt
  const settlementResult = await MechanicDebt.settleDebt(
    mechanicId,
    razorpay_payment_id,
    amountPaid,
    'MANUAL_PAYMENT'
  );

  // Re-query actual remaining debt from DB
  const actualRemainingDebt = await MechanicDebt.getTotalActiveDebt(mechanicId);

  // If debt is fully cleared, unblock mechanic
  if (actualRemainingDebt <= 0) {
    await Mechanic.findByIdAndUpdate(mechanicId, { hasActiveDebt: false });
  }

  // Save to CompanyLedger as received amount
  await CompanyLedger.create({
    mechanicId,
    amount: amountPaid,
    paymentMethod: 'ONLINE',
    status: 'SETTLED',
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
    settledAt: new Date(),
    notes: 'Mechanic manual debt clearance',
  });

  ApiResponse.success(res, {
    paymentId: razorpay_payment_id,
    clearedAmount: amountPaid,
    remainingDebt: actualRemainingDebt,
  }, 'Debt cleared successfully');
});

/**
 * Unified transaction history for the mechanic wallet.
 * Merges MechanicEarning records (credits/deductions) and MechanicPayout
 * records (withdrawals) into a single chronological list.
 *
 * GET /api/mechanic/wallet/transactions
 */
const getWalletTransactions = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 30 });
  const skip = (page - 1) * limit;

  // Fetch earnings and payouts in parallel
  const [earnings, payouts, walletBalance, pendingReserve] = await Promise.all([
    MechanicEarning.find({ mechanicId: new mongoose.Types.ObjectId(mechanicId) })
      .sort({ createdAt: -1 })
      .select('bookingCode grossAmount netAmount paymentMethod paymentStatus status createdAt notes serviceDetails')
      .populate('bookingId', 'bookingId'),
    require('../models/MechanicPayout').find({ mechanicId: new mongoose.Types.ObjectId(mechanicId) })
      .sort({ createdAt: -1 })
      .select('payoutId amount status breakdown createdAt completedAt'),
    cashflowSettlementService.getMechanicWalletBalance(mechanicId),
    cashflowSettlementService.getPendingWithdrawalReserveAmount(mechanicId),
  ]);

  const spendable = walletBalance.balance - pendingReserve;
  const minPayoutInr = getMinPayoutInr();
  const bookCheck = await cashflowSettlementService.canMechanicBook(mechanicId);

  // Map earnings → unified transaction format
  const earningTxns = earnings.map(e => ({
    id: e._id,
    type: e.netAmount >= 0 ? 'CREDIT' : 'DEBIT',
    subtype: 'EARNING',
    amount: Math.abs(e.netAmount),
    paymentMethod: e.paymentMethod,
    status: e.status,
    description: `Service earned${e.serviceDetails?.name ? ` — ${e.serviceDetails.name}` : ''}`,
    bookingCode: e.bookingCode,
    notes: e.notes,
    date: e.createdAt,
  }));

  // Map payouts → unified transaction format
  const payoutTxns = payouts.map(p => ({
    id: p._id,
    type: 'DEBIT',
    subtype: 'WITHDRAWAL',
    amount: p.amount,
    paymentMethod: 'BANK_TRANSFER',
    status: p.status,
    description: 'Wallet withdrawal',
    payoutId: p.payoutId,
    netAmount: p.breakdown?.netAmount,
    date: p.createdAt,
    completedAt: p.completedAt,
  }));

  // Merge, sort by date descending, paginate
  const all = [...earningTxns, ...payoutTxns].sort((a, b) => new Date(b.date) - new Date(a.date));
  const total = all.length;
  const paginated = all.slice(skip, skip + limit);

  return res.status(200).json({
    success: true,
    message: 'Wallet transactions fetched',
    data: paginated,
    pagination: {
      currentPage: page,
      totalPages: Math.ceil(total / limit),
      totalItems: total,
      itemsPerPage: limit,
    },
    walletBalance: {
      balance: walletBalance.balance,
      netBalance: walletBalance.balance,
      onHoldBalance: walletBalance.onHoldBalance ?? 0,
      totalEarnings: walletBalance.totalEarnings,
      totalDebt: walletBalance.totalDebt,
      pendingPayoutReserve: pendingReserve,
      spendableBalance: spendable,
      minPayoutAmount: minPayoutInr,
      canRequestPayout: walletBalance.totalDebt <= 0 && spendable >= minPayoutInr,
      isNegative: walletBalance.balance < 0,
    },
    canBook: bookCheck.canBook,
    bookingRestriction: bookCheck,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Queue wallet withdrawal — admin validates then money is deducted + Razorpay sent.
 *
 * POST /api/mechanic/wallet/withdraw
 * Body: { amount: number, payoutMethod: "BANK" | "UPI" }
 */
const withdrawWallet = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;
  const { amount, payoutMethod = 'BANK' } = req.body;
  const minPayoutInr = getMinPayoutInr();

  const MAX_DAILY_WITHDRAWAL = 50000;

  if (!amount || amount < minPayoutInr) {
    return ApiResponse.badRequest(res, `Minimum withdrawal is ₹${minPayoutInr}. Clear any debt first.`);
  }

  if (!['BANK', 'UPI'].includes(payoutMethod)) {
    return ApiResponse.badRequest(res, 'payoutMethod must be BANK or UPI');
  }

  return distributedLock.withLock(`wallet:withdraw:${mechanicId}`, async () => {

  const mechanic = await Mechanic.findById(mechanicId).select('fullName bankDetails');
  if (!mechanic) return ApiResponse.notFound(res, 'Mechanic not found');

  if (payoutMethod === 'BANK') {
    if (!mechanic.bankDetails?.accountNumber || !mechanic.bankDetails?.ifscCode) {
      return ApiResponse.badRequest(res, 'Bank account details not found. Please add them in your profile.');
    }
  } else if (!mechanic.bankDetails?.upiId) {
    return ApiResponse.badRequest(res, 'UPI ID not found. Please add it in your profile.');
  }

  const walletBalance = await cashflowSettlementService.getMechanicWalletBalance(mechanicId);

  if (walletBalance.totalDebt > 0) {
    return ApiResponse.badRequest(
      res,
      `Clear ₹${walletBalance.totalDebt.toFixed(2)} platform fee debt before requesting payout.`,
    );
  }

  const MechanicPayout = require('../models/MechanicPayout');

  const alreadyQueued = await MechanicPayout.findOne({
    mechanicId: new mongoose.Types.ObjectId(mechanicId),
    status: { $in: ['REQUESTED', 'ON_HOLD'] },
  });
  if (alreadyQueued) {
    return ApiResponse.badRequest(res, 'You already have a payout in the queue.');
  }

  const pendingReserve = await cashflowSettlementService.getPendingWithdrawalReserveAmount(mechanicId);
  const spendable = walletBalance.balance - pendingReserve;

  if (spendable < minPayoutInr) {
    return ApiResponse.badRequest(
      res,
      `Minimum ₹${minPayoutInr} available balance required after pending holds.`,
    );
  }

  if (amount > spendable) {
    return ApiResponse.badRequest(
      res,
      `Insufficient spendable balance. Available: ₹${spendable.toFixed(2)}`,
    );
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayPayouts = await MechanicPayout.aggregate([
    {
      $match: {
        mechanicId: new mongoose.Types.ObjectId(mechanicId),
        createdAt: { $gte: todayStart },
        status: { $nin: ['CANCELLED', 'FAILED'] },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const todayTotal = todayPayouts[0]?.total || 0;
  if (todayTotal + amount > MAX_DAILY_WITHDRAWAL) {
    return ApiResponse.badRequest(
      res,
      `Daily withdrawal limit (₹${MAX_DAILY_WITHDRAWAL}) exceeded. Remaining: ₹${MAX_DAILY_WITHDRAWAL - todayTotal}`,
    );
  }

  const tds = amount > 10000 ? Math.round(amount * 0.01) : 0;
  const netPayout = amount - tds;

  const delayMs =
    parseInt(process.env.PAYOUT_AUTO_DELAY_MS, 10) || 24 * 60 * 60 * 1000;
  const scheduledProcessAt = new Date(Date.now() + delayMs);

  const humanDelay =
    delayMs >= 3600000
      ? `~${Math.max(1, Math.round(delayMs / 3600000))} hour(s)`
      : delayMs >= 60000
        ? `~${Math.max(1, Math.round(delayMs / 60000))} minute(s)`
        : `~${Math.max(1, Math.round(delayMs / 1000))} second(s)`;

  const payout = await MechanicPayout.create({
    mechanicId: new mongoose.Types.ObjectId(mechanicId),
    amount,
    bankDetails: {
      accountHolderName: mechanic.bankDetails.accountHolderName || mechanic.fullName,
      accountNumber: mechanic.bankDetails.accountNumber || '',
      ifscCode: mechanic.bankDetails.ifscCode || '',
      bankName: mechanic.bankDetails.bankName,
      upiId: mechanic.bankDetails.upiId,
    },
    paymentGateway: payoutMethod === 'UPI' ? 'RAZORPAY' : 'BANK_TRANSFER',
    status: 'REQUESTED',
    scheduledProcessAt,
    breakdown: { totalEarnings: amount, tds, otherDeductions: 0, netAmount: netPayout },
  });

  try {
    const payoutQueue = require('../services/payoutQueue.service');
    await payoutQueue.schedulePayoutExecution(payout._id.toString(), delayMs);
  } catch (e) {
    logger.warn('[wallet/withdraw] schedule payout job failed', { error: e.message });
  }

  await AuditLog.create({
    category: 'PAYOUT',
    action: 'PAYOUT_QUEUED',
    mechanicId,
    amount,
    status: 'REQUESTED',
    meta: {
      payoutId: payout._id.toString(),
      payoutHumanId: payout.payoutId,
      payoutMethod,
      scheduledProcessAt: scheduledProcessAt.toISOString(),
    },
  }).catch(() => {});

  ApiResponse.success(
    res,
    {
      withdrawal: {
        id: payout._id,
        payoutId: payout.payoutId,
        amount,
        tds,
        netAmount: netPayout,
        payoutMethod,
        status: payout.status,
        scheduledProcessAt: scheduledProcessAt.toISOString(),
        delayMs,
        delayMinutes: Math.round(delayMs / 60000) || null,
        message:
          `Queued — wallet reserved. Auto transfer in ${humanDelay} (admin can approve sooner).`,
      },
      spendableBalanceAfterQueue: spendable - amount,
    },
    'Withdrawal queued for automatic processing.',
  );
  });
});

/**
 * Auto-clear debt by deducting from available wallet balance.
 * Only allowed when wallet balance >= total active debt.
 *
 * POST /api/mechanic/wallet/auto-clear-debt
 */
const autoClearDebt = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;

  return distributedLock.withLock(`wallet:debt:${mechanicId}`, async () => {
    const walletBalance = await cashflowSettlementService.getMechanicWalletBalance(mechanicId);
    const totalDebt = Math.round(Number(walletBalance.totalDebt) * 100) / 100;

    if (totalDebt <= 0) {
      return ApiResponse.badRequest(res, 'No active debt to clear');
    }

    if (walletBalance.balance < totalDebt) {
      return ApiResponse.badRequest(
        res,
        `Insufficient wallet balance. Have ₹${walletBalance.balance.toFixed(2)}, need ₹${totalDebt.toFixed(2)}. Pay via UPI instead.`
      );
    }

  // Settle all active debts
  await MechanicDebt.settleDebt(mechanicId, `WALLET_AUTO_${Date.now()}`, totalDebt, 'WALLET_DEDUCTION');

  // Create negative earning to reduce wallet balance by the debt amount
  await MechanicEarning.create({
    mechanicId: new mongoose.Types.ObjectId(mechanicId),
    bookingCode: `DEBT-CLR-${Date.now().toString().slice(-8)}`,
    grossAmount: -totalDebt,
    netAmount: -totalDebt,
    type: 'ADJUSTMENT',
    status: 'AVAILABLE',
    serviceDetails: { name: 'Platform Fee Deduction' },
    serviceDate: new Date(),
  });

  // Release ON_HOLD earnings and unblock mechanic
  await cashflowSettlementService.releaseOnHoldEarnings(mechanicId);
  await Mechanic.findByIdAndUpdate(mechanicId, { hasActiveDebt: false });

  const newBalance = await cashflowSettlementService.getMechanicWalletBalance(mechanicId);

  logger.info(`✅ Auto-cleared ₹${totalDebt} debt for mechanic ${mechanicId}`);

  ApiResponse.success(res, {
    cleared: totalDebt,
    newBalance: newBalance.balance,
    newTotalEarnings: newBalance.totalEarnings,
  }, `Debt of ₹${totalDebt} cleared from your wallet. You can now accept new bookings.`);
  });
});

const getCashStatus = asyncHandler(async (req, res) => {
  const mechanicId = req.mechanic.id;
  const status = await cashLimitPolicyService.getMechanicCashStatus(mechanicId);
  ApiResponse.success(res, { cashStatus: status });
});

module.exports = {
  getWalletSummary,
  getEarningsHistory,
  getDebtDetails,
  getTestWallet,
  createDebtClearanceOrder,
  generateFinePaymentLink,
  autoClearDebt,
  verifyDebtClearancePayment,
  getWalletTransactions,
  withdrawWallet,
  syncDebtStatus,
  getCashStatus,
};
