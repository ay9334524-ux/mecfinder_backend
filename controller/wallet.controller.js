const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const razorpayService = require('../services/razorpay.service');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');
const { clampLimit, clampPage } = require('../utils/pagination');

/**
 * Get wallet details
 * GET /api/wallet
 */
const getWallet = asyncHandler(async (req, res) => {
  const wallet = await Wallet.getOrCreate(req.user.id);
  
  // Get recent transactions
  const recentTransactions = await WalletTransaction.find({ userId: req.user.id })
    .sort({ createdAt: -1 })
    .limit(5);

  ApiResponse.success(res, {
    wallet: {
      balance: wallet.balance,
      currency: wallet.currency,
      lastTransactionAt: wallet.lastTransactionAt,
    },
    recentTransactions,
  });
});

/**
 * Get wallet transactions
 * GET /api/wallet/transactions
 */
const getTransactions = asyncHandler(async (req, res) => {
  const { type, source } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 20 });
  const skip = (page - 1) * limit;

  const filter = { userId: req.user.id };
  if (type) filter.type = type;
  if (source) filter.source = source;

  const [transactions, total] = await Promise.all([
    WalletTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    WalletTransaction.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, transactions, {
    page,
    limit,
    total,
  });
});

/**
 * Create order to add money
 * POST /api/wallet/add-money
 */
const addMoney = asyncHandler(async (req, res) => {
  const { amount } = req.body;

  if (amount < 10) {
    return ApiResponse.badRequest(res, 'Minimum amount is ₹10');
  }

  if (amount > 50000) {
    return ApiResponse.badRequest(res, 'Maximum amount is ₹50,000');
  }

  // Create Razorpay order
  const orderResult = await razorpayService.createOrder({
    amount,
    receipt: `wallet_${req.user.id}_${Date.now()}`,
    notes: {
      userId: req.user.id.toString(),
      purpose: 'WALLET_RECHARGE',
    },
  });

  if (!orderResult.success) {
    return ApiResponse.serverError(res, 'Failed to create payment order');
  }

  // Create pending transaction
  const wallet = await Wallet.getOrCreate(req.user.id);
  
  await WalletTransaction.create({
    walletId: wallet._id,
    userId: req.user.id,
    type: 'CREDIT',
    amount,
    balanceAfter: wallet.balance + amount, // Expected balance after success
    source: 'RECHARGE',
    description: 'Wallet recharge',
    referenceId: orderResult.order.id,
    referenceType: 'RAZORPAY_ORDER',
    paymentDetails: {
      razorpayOrderId: orderResult.order.id,
    },
    status: 'PENDING',
  });

  ApiResponse.success(res, {
    orderId: orderResult.order.id,
    amount: orderResult.order.amount,
    currency: orderResult.order.currency,
    keyId: razorpayService.getKeyId(),
  }, 'Payment order created');
});

/**
 * Verify payment and credit wallet
 * POST /api/wallet/verify-payment
 */
const verifyPayment = asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return ApiResponse.badRequest(res, 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
  }

  // razorpayService.verifyPayment expects positional args (orderId, paymentId, signature)
  const verification = razorpayService.verifyPayment(
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  );

  if (!verification.success) {
    await WalletTransaction.findOneAndUpdate(
      { referenceId: razorpay_order_id, userId: req.user.id },
      { status: 'FAILED' }
    );
    return ApiResponse.badRequest(res, 'Payment verification failed');
  }

  // Idempotent atomic completion: only update if still PENDING.
  const transaction = await WalletTransaction.findOneAndUpdate(
    {
      referenceId: razorpay_order_id,
      userId: req.user.id,
      status: 'PENDING',
    },
    {
      $set: {
        status: 'COMPLETED',
        'paymentDetails.razorpayPaymentId': razorpay_payment_id,
        'paymentDetails.razorpaySignature': razorpay_signature,
      },
    },
    { new: true }
  );

  if (!transaction) {
    // Either does not exist or already processed — check to give a clear response.
    const existing = await WalletTransaction.findOne({ referenceId: razorpay_order_id, userId: req.user.id });
    if (!existing) {
      return ApiResponse.notFound(res, 'Transaction not found');
    }
    if (existing.status === 'COMPLETED') {
      // Idempotent success — same payment verified again.
      const wallet = await Wallet.getOrCreate(req.user.id);
      return ApiResponse.success(res, { wallet: { balance: wallet.balance }, transaction: existing }, 'Payment already processed');
    }
    return ApiResponse.badRequest(res, `Cannot complete transaction in status ${existing.status}`);
  }

  // Credit wallet AFTER atomically claiming the transaction.
  const wallet = await Wallet.getOrCreate(req.user.id);
  await wallet.credit(transaction.amount);

  transaction.balanceAfter = wallet.balance;
  await transaction.save();

  ApiResponse.success(res, {
    wallet: { balance: wallet.balance },
    transaction,
  }, 'Payment successful! Wallet credited');
});

/**
 * Process refund to wallet (internal use) — atomic credit + transaction record.
 */
const creditRefund = async (userId, amount, bookingId, description) => {
  // Ensure wallet exists (needed for walletId in the ledger row).
  const baseWallet = await Wallet.getOrCreate(userId);

  // Atomic credit first; if it fails, no ledger row is created.
  const wallet = await Wallet.atomicCredit(userId, amount);

  const transaction = await WalletTransaction.create({
    walletId: baseWallet._id,
    userId,
    type: 'CREDIT',
    amount,
    balanceAfter: wallet.balance,
    source: 'REFUND',
    description: description || 'Booking refund',
    referenceId: bookingId,
    referenceType: 'BOOKING',
    status: 'COMPLETED',
  });

  return { wallet, transaction };
};

/**
 * Debit wallet for booking (internal use) — atomic to prevent overdraw races.
 */
const debitForBooking = async (userId, amount, bookingId) => {
  try {
    const baseWallet = await Wallet.getOrCreate(userId);

    // Atomic conditional decrement; returns null if insufficient balance.
    const wallet = await Wallet.atomicDebit(userId, amount);
    if (!wallet) {
      return { success: false, message: 'Insufficient wallet balance' };
    }

    const transaction = await WalletTransaction.create({
      walletId: baseWallet._id,
      userId,
      type: 'DEBIT',
      amount,
      balanceAfter: wallet.balance,
      source: 'BOOKING',
      description: 'Booking payment',
      referenceId: bookingId,
      referenceType: 'BOOKING',
      status: 'COMPLETED',
    });

    return { success: true, wallet, transaction, transactionId: transaction._id.toString() };
  } catch (error) {
    console.error('Wallet debit error:', error.message);
    return { success: false, message: error.message };
  }
};

/**
 * Credit promotional amount (internal use)
 */
const creditPromo = async (userId, amount, description, referenceId) => {
  const baseWallet = await Wallet.getOrCreate(userId);
  const wallet = await Wallet.atomicCredit(userId, amount);

  const transaction = await WalletTransaction.create({
    walletId: baseWallet._id,
    userId,
    type: 'CREDIT',
    amount,
    balanceAfter: wallet.balance,
    source: 'PROMO',
    description,
    referenceId,
    referenceType: 'PROMO',
    status: 'COMPLETED',
  });

  return { wallet, transaction };
};

/**
 * Credit referral bonus (internal use)
 */
const creditReferralBonus = async (userId, amount, referralId) => {
  const baseWallet = await Wallet.getOrCreate(userId);
  const wallet = await Wallet.atomicCredit(userId, amount);

  const transaction = await WalletTransaction.create({
    walletId: baseWallet._id,
    userId,
    type: 'CREDIT',
    amount,
    balanceAfter: wallet.balance,
    source: 'REFERRAL',
    description: 'Referral bonus',
    referenceId: referralId,
    referenceType: 'REFERRAL',
    status: 'COMPLETED',
  });

  return { wallet, transaction };
};

module.exports = {
  getWallet,
  getTransactions,
  addMoney,
  verifyPayment,
  // Internal functions
  creditRefund,
  debitForBooking,
  creditPromo,
  creditReferralBonus,
};
