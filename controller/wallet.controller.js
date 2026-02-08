const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const razorpayService = require('../services/razorpay.service');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

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
  const { page = 1, limit = 20, type, source } = req.query;
  const skip = (page - 1) * limit;

  const filter = { userId: req.user.id };
  if (type) filter.type = type;
  if (source) filter.source = source;

  const [transactions, total] = await Promise.all([
    WalletTransaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit)),
    WalletTransaction.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, transactions, {
    page: parseInt(page),
    limit: parseInt(limit),
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

  // Verify payment signature
  const verification = razorpayService.verifyPayment({
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  });

  if (!verification.success) {
    // Update transaction as failed
    await WalletTransaction.findOneAndUpdate(
      { referenceId: razorpay_order_id },
      { status: 'FAILED' }
    );
    return ApiResponse.badRequest(res, 'Payment verification failed');
  }

  // Get the pending transaction
  const transaction = await WalletTransaction.findOne({
    referenceId: razorpay_order_id,
    userId: req.user.id,
  });

  if (!transaction) {
    return ApiResponse.notFound(res, 'Transaction not found');
  }

  if (transaction.status === 'COMPLETED') {
    return ApiResponse.badRequest(res, 'Payment already processed');
  }

  // Update wallet balance
  const wallet = await Wallet.getOrCreate(req.user.id);
  await wallet.credit(transaction.amount);

  // Update transaction
  transaction.status = 'COMPLETED';
  transaction.balanceAfter = wallet.balance;
  transaction.paymentDetails.razorpayPaymentId = razorpay_payment_id;
  transaction.paymentDetails.razorpaySignature = razorpay_signature;
  await transaction.save();

  ApiResponse.success(res, {
    wallet: {
      balance: wallet.balance,
    },
    transaction,
  }, 'Payment successful! Wallet credited');
});

/**
 * Process refund to wallet (internal use)
 */
const creditRefund = async (userId, amount, bookingId, description) => {
  const wallet = await Wallet.getOrCreate(userId);
  
  const transaction = await WalletTransaction.create({
    walletId: wallet._id,
    userId,
    type: 'CREDIT',
    amount,
    balanceAfter: wallet.balance + amount,
    source: 'REFUND',
    description: description || 'Booking refund',
    referenceId: bookingId,
    referenceType: 'BOOKING',
    status: 'COMPLETED',
  });

  await wallet.credit(amount);

  return { wallet, transaction };
};

/**
 * Debit wallet for booking (internal use)
 */
const debitForBooking = async (userId, amount, bookingId) => {
  try {
    const wallet = await Wallet.getOrCreate(userId);
    
    if (wallet.balance < amount) {
      return { success: false, message: 'Insufficient wallet balance' };
    }

    const transaction = await WalletTransaction.create({
      walletId: wallet._id,
      userId,
      type: 'DEBIT',
      amount,
      balanceAfter: wallet.balance - amount,
      source: 'BOOKING',
      description: 'Booking payment',
      referenceId: bookingId,
      referenceType: 'BOOKING',
      status: 'COMPLETED',
    });

    await wallet.debit(amount);

    return { success: true, wallet, transaction, transactionId: transaction._id.toString() };
  } catch (error) {
    console.error('Wallet debit error:', error);
    return { success: false, message: error.message };
  }
};

/**
 * Credit promotional amount (internal use)
 */
const creditPromo = async (userId, amount, description, referenceId) => {
  const wallet = await Wallet.getOrCreate(userId);
  
  const transaction = await WalletTransaction.create({
    walletId: wallet._id,
    userId,
    type: 'CREDIT',
    amount,
    balanceAfter: wallet.balance + amount,
    source: 'PROMO',
    description,
    referenceId,
    referenceType: 'PROMO',
    status: 'COMPLETED',
  });

  await wallet.credit(amount);

  return { wallet, transaction };
};

/**
 * Credit referral bonus (internal use)
 */
const creditReferralBonus = async (userId, amount, referralId) => {
  const wallet = await Wallet.getOrCreate(userId);
  
  const transaction = await WalletTransaction.create({
    walletId: wallet._id,
    userId,
    type: 'CREDIT',
    amount,
    balanceAfter: wallet.balance + amount,
    source: 'REFERRAL',
    description: 'Referral bonus',
    referenceId: referralId,
    referenceType: 'REFERRAL',
    status: 'COMPLETED',
  });

  await wallet.credit(amount);

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
