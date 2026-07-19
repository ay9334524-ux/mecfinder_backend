const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const MechanicDebt = require('../models/MechanicDebt');
const Wallet = require('../models/Wallet');
const WalletTransaction = require('../models/WalletTransaction');
const CompanyLedger = require('../models/CompanyLedger');
const razorpayService = require('../services/razorpay.service');
const earningsController = require('./earnings.controller');
const cashflowSettlementService = require('../services/cashflowSettlement.service');
const socketService = require('../services/socket.service');
const redisService = require('../services/redis.service');
const ApiResponse = require('../utils/apiResponse');
const AuditLog = require('../models/AuditLog');

// 7 days is well past Razorpay's max retry window (2 days), but cheap to keep.
const WEBHOOK_REPLAY_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Replay protection — claim the event ID in Redis. Returns true if this is
 * the first time we've seen this event. Returns false if it's a replay.
 *
 * On Redis outage we fail OPEN (return true) so a Razorpay event isn't lost
 * just because Redis blipped — the booking/wallet-level "already processed"
 * checks downstream still prevent double-credits in nearly every path.
 */
async function _claimWebhookEvent(eventId) {
  if (!eventId) return true;
  try {
    if (!redisService.client || !redisService.isConnected) return true;
    const result = await redisService.client.set(
      `webhook:razorpay:${eventId}`,
      Date.now().toString(),
      { NX: true, EX: WEBHOOK_REPLAY_TTL_SECONDS },
    );
    return result === 'OK';
  } catch (err) {
    console.warn(`⚠️ Webhook replay-check failed (fail-open): ${err.message}`);
    return true;
  }
}

/**
 * Mark job booking paid, credit mechanic earning, ledger, sockets (idempotent).
 */
async function settleJobBookingPaymentFromRazorpay(booking, {
  paymentId,
  amountPaid,
  razorpayPaymentLinkId,
  razorpayQrCodeId,
  statusNote = 'Paid online via Razorpay',
}) {
  if (!booking || booking.paymentStatus === 'PAID') {
    return { settled: false };
  }

  const mechanicId = booking.mechanicId?.toString();

  booking.paymentStatus = 'PAID';
  booking.paymentMethod = 'UPI';
  booking.status = booking.status === 'IN_PROGRESS' ? 'COMPLETED' : booking.status;
  booking.completedAt = booking.completedAt || new Date();
  booking.paymentDetails = {
    ...booking.paymentDetails,
    ...(razorpayPaymentLinkId ? { razorpayPaymentLinkId } : {}),
    ...(razorpayQrCodeId ? { razorpayQrCodeId } : {}),
    razorpayPaymentId: paymentId,
    onlineAmount: amountPaid,
    paidAt: new Date(),
    collectedByMechanic: false,
  };
  if (!booking.statusHistory) booking.statusHistory = [];
  booking.statusHistory.push({
    status: 'COMPLETED',
    timestamp: new Date(),
    notes: statusNote,
  });
  await booking.save();

  const customer = await User.findById(booking.userId);
  await earningsController.createEarning({
    bookingId: booking._id,
    bookingCode: booking.bookingId,
    mechanicId: booking.mechanicId,
    grossAmount: booking.pricing?.mechanicEarning || 0,
    platformFeePercent: 0,
    platformFeeAmount: 0,
    gstOnPlatformFee: 0,
    netAmount: booking.pricing?.mechanicEarning || 0,
    serviceDetails: {
      name: booking.serviceSnapshot?.name || 'Service',
      category: booking.serviceSnapshot?.categoryName || 'General',
    },
    customerName: customer?.name || 'Customer',
    customerPhone: customer?.phone || '',
    location: { address: booking.location?.address || '' },
    paymentMethod: 'UPI',
    status: 'AVAILABLE',
  });

  await CompanyLedger.findOneAndUpdate(
    { bookingId: booking._id },
    {
      bookingId: booking._id,
      userId: booking.userId,
      mechanicId: booking.mechanicId,
      amount: booking.pricing?.companyEarning || 0,
      paymentMethod: 'ONLINE',
      status: 'SETTLED',
      razorpayPaymentId: paymentId,
      settledAt: new Date(),
    },
    { upsert: true, new: true }
  );

  if (mechanicId) {
    socketService.emitToMechanic(mechanicId, 'job:payment_confirmed', {
      bookingId: booking._id,
      bookingCode: booking.bookingId,
      amount: amountPaid,
      mechanicEarning: booking.pricing?.mechanicEarning || 0,
      message: '✅ Payment received! You can now mark the job as complete.',
    });
  }

  socketService.emitToUser(booking.userId?.toString(), 'booking:payment_confirmed', {
    bookingId: booking._id,
    amount: amountPaid,
    showRatingPrompt: true,
  });

  return { settled: true, mechanicId };
}

const handleRazorpayWebhook = async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body);

  const isValid = razorpayService.validateWebhookSignature(rawBody, signature);
  if (!isValid) {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret || webhookSecret === 'your_webhook_secret_here') {
      return ApiResponse.unauthorized(res, 'Webhook secret not configured. Configure RAZORPAY_WEBHOOK_SECRET in .env');
    }
    return ApiResponse.unauthorized(res, 'Invalid webhook signature');
  }

  const payload = req.body instanceof Buffer ? JSON.parse(rawBody) : req.body;
  const event = payload.event;

  // Razorpay sends a unique event id (`x-razorpay-event-id` header, also
  // `payload.id`). Reject duplicates — without this a leaked or replayed
  // valid-signature webhook could double-credit a wallet recharge.
  const eventId = req.headers['x-razorpay-event-id'] || payload.id || null;
  const isFirstTime = await _claimWebhookEvent(eventId);
  if (!isFirstTime) {
    console.log(`↩️  [webhook] Replay ignored event=${event} id=${eventId}`);
    return ApiResponse.success(res, { received: true, replay: true }, 'Replay ignored');
  }

  // ──────────────────────────────────────────────────────────────
  // qr_code.credited — customer paid via Razorpay UPI QR (native UPI apps)
  // Subscribe in Razorpay Dashboard → Webhooks → QR Code events.
  // ──────────────────────────────────────────────────────────────
  if (event === 'qr_code.credited') {
    const qrEntity = payload?.payload?.qr_code?.entity;
    const paymentEntity = payload?.payload?.payment?.entity;

    if (!qrEntity || !paymentEntity || paymentEntity.status !== 'captured') {
      return ApiResponse.success(res, { received: true }, 'QR credited — no actionable payment');
    }

    const notes = qrEntity.notes || {};
    if (notes.purpose === 'JOB_PAYMENT' && notes.bookingId) {
      const booking = await Booking.findById(notes.bookingId);
      if (!booking || booking.paymentStatus === 'PAID') {
        return ApiResponse.success(res, { received: true }, 'Already handled');
      }

      const expectedPaise = Math.round(Number(booking.pricing?.totalAmount || 0) * 100);
      if (expectedPaise >= 100 && Number(paymentEntity.amount) !== expectedPaise) {
        console.error(
          `[webhook] qr_code.credited amount mismatch booking=${notes.bookingId} expectedPaise=${expectedPaise} got=${paymentEntity.amount}`
        );
        return ApiResponse.success(res, { received: true }, 'Amount mismatch — not settled');
      }

      const paymentId = paymentEntity.id;
      const amountPaid = (paymentEntity.amount || 0) / 100;

      await settleJobBookingPaymentFromRazorpay(booking, {
        paymentId,
        amountPaid,
        razorpayQrCodeId: qrEntity.id,
        statusNote: 'Paid via Razorpay UPI QR',
      });

      console.log(`✅ [webhook] JOB_PAYMENT (UPI QR) booking=${notes.bookingId}`);
      return ApiResponse.success(res, { received: true }, 'Job payment confirmed (UPI QR)');
    }

    return ApiResponse.success(res, { received: true }, 'QR credited — unrelated');
  }

  // ──────────────────────────────────────────────────────────────
  // payment_link.paid — customer paid a payment link
  // ──────────────────────────────────────────────────────────────
  if (event === 'payment_link.paid') {
    const linkEntity = payload?.payload?.payment_link?.entity;
    const paymentEntity = payload?.payload?.payment?.entity;

    if (!linkEntity) {
      return ApiResponse.success(res, { received: true }, 'No payment link entity');
    }

    const notes = linkEntity.notes || {};
    const purpose = notes.purpose;
    const paymentId = paymentEntity?.id;
    const amountPaid = (paymentEntity?.amount || linkEntity.amount_paid || 0) / 100;

    // ── JOB_PAYMENT: customer paid mechanic's job via payment link ──
    if (purpose === 'JOB_PAYMENT' && notes.bookingId) {
      const booking = await Booking.findById(notes.bookingId);
      if (!booking || booking.paymentStatus === 'PAID') {
        return ApiResponse.success(res, { received: true }, 'Already handled');
      }

      await settleJobBookingPaymentFromRazorpay(booking, {
        paymentId,
        amountPaid,
        razorpayPaymentLinkId: linkEntity.id,
        statusNote: 'Paid via Razorpay payment link',
      });

      console.log(`✅ [webhook] JOB_PAYMENT (payment link) booking=${notes.bookingId}`);
      return ApiResponse.success(res, { received: true }, 'Job payment confirmed');
    }

    // ── FINE_PAYMENT: mechanic paid platform commission debt ──
    if (purpose === 'FINE_PAYMENT' && notes.mechanicId) {
      const mechanicId = notes.mechanicId;
      const debtAmount = parseFloat(notes.debtAmount || amountPaid);

      // Settle all active debt
      const settlementResult = await MechanicDebt.settleDebt(
        mechanicId,
        paymentId || linkEntity.id,
        amountPaid,
        'PAYMENT_LINK'
      );

      // Re-query actual remaining debt from DB (settleDebt.remainingDebt
      // is leftover payment, not remaining debt balance).
      const actualRemainingDebt = await MechanicDebt.getTotalActiveDebt(mechanicId);

      await AuditLog.create({
        category: 'DEBT',
        action: 'FINE_PAID_WEBHOOK',
        mechanicId: mongoose.Types.ObjectId.isValid(mechanicId)
          ? new mongoose.Types.ObjectId(mechanicId)
          : mechanicId,
        amount: amountPaid,
        status: actualRemainingDebt <= 0 ? 'CLEARED' : 'PARTIAL',
        meta: {
          razorpayPaymentId: paymentId,
          remainingDebt: actualRemainingDebt,
        },
      }).catch(() => {});

      // If fully cleared, unblock mechanic + release ON_HOLD earnings
      if (actualRemainingDebt <= 0) {
        await Mechanic.findByIdAndUpdate(mechanicId, { hasActiveDebt: false });
        await cashflowSettlementService.releaseOnHoldEarnings(mechanicId);

        socketService.emitToMechanic(mechanicId, 'wallet:debt_cleared', {
          clearedAmount: amountPaid,
          message: '🎉 Debt cleared! Your earnings are now available.',
        });
      } else {
        socketService.emitToMechanic(mechanicId, 'wallet:debt_partial', {
          clearedAmount: amountPaid,
          remainingDebt: actualRemainingDebt,
          message: `₹${actualRemainingDebt} still pending.`,
        });
      }

      console.log(`✅ [webhook] FINE_PAYMENT by mechanic ${mechanicId}, cleared ₹${amountPaid}, remaining ₹${actualRemainingDebt}`);
      return ApiResponse.success(res, { received: true }, 'Fine payment confirmed');
    }

    return ApiResponse.success(res, { received: true }, `Unhandled payment link purpose: ${purpose}`);
  }

  // ──────────────────────────────────────────────────────────────
  // payment.captured — classic Razorpay order payment
  // ──────────────────────────────────────────────────────────────
  const paymentEntity = payload?.payload?.payment?.entity;

  if (!paymentEntity) {
    return ApiResponse.success(res, { received: true }, 'No payment entity');
  }

  const { order_id, id: paymentId, amount, method, status, notes } = paymentEntity;
  const amountInRupees = amount ? amount / 100 : 0;

  if (status !== 'captured') {
    return ApiResponse.success(res, { received: true }, 'Payment not captured');
  }

  const purpose = notes?.purpose;
  const bookingId = notes?.bookingId;
  const userId = notes?.userId;

  if (purpose === 'WALLET_RECHARGE' && userId) {
    const transaction = await WalletTransaction.findOne({
      referenceId: order_id,
      userId,
      status: 'PENDING',
    });

    if (!transaction) {
      return ApiResponse.success(res, { received: true }, 'No pending wallet transaction');
    }

    if (transaction.amount !== amountInRupees) {
      return ApiResponse.badRequest(res, 'Amount mismatch for wallet recharge');
    }

    const wallet = await Wallet.getOrCreate(userId);
    await wallet.credit(transaction.amount);

    transaction.status = 'COMPLETED';
    transaction.balanceAfter = wallet.balance;
    transaction.paymentDetails.razorpayPaymentId = paymentId;
    transaction.paymentDetails.method = method;
    await transaction.save();

    return ApiResponse.success(res, { received: true }, 'Wallet recharged');
  }

  if (purpose === 'BOOKING_PAYMENT' && bookingId) {
    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return ApiResponse.success(res, { received: true }, 'Booking not found');
    }

    if (booking.paymentStatus === 'PAID') {
      return ApiResponse.success(res, { received: true }, 'Booking already paid');
    }

    if (booking.paymentDetails?.razorpayOrderId && booking.paymentDetails.razorpayOrderId !== order_id) {
      return ApiResponse.badRequest(res, 'Order mismatch for booking');
    }

    if (booking.pricing?.totalAmount && booking.pricing.totalAmount !== amountInRupees) {
      return ApiResponse.badRequest(res, 'Amount mismatch for booking');
    }

    booking.paymentStatus = 'PAID';
    booking.paymentMethod = method?.toUpperCase() === 'UPI' ? 'UPI' : 'CARD';
    booking.paymentDetails = {
      ...booking.paymentDetails,
      razorpayOrderId: order_id,
      razorpayPaymentId: paymentId,
      onlineAmount: amountInRupees,
      paidAt: new Date(),
    };
    await booking.save();

    const customer = await User.findById(booking.userId);

    await earningsController.createEarning({
      bookingId: booking._id,
      bookingCode: booking.bookingId,
      mechanicId: booking.mechanicId,
      grossAmount: booking.pricing?.mechanicEarning || 0,
      platformFeePercent: 0,
      platformFeeAmount: 0,
      gstOnPlatformFee: 0,
      netAmount: booking.pricing?.mechanicEarning || 0,
      serviceDetails: {
        name: booking.serviceSnapshot?.name || 'Service',
        category: booking.serviceSnapshot?.categoryName || 'General',
      },
      customerName: customer?.name || 'Customer',
      customerPhone: customer?.phone || '',
      location: { address: booking.location?.address || '' },
      paymentMethod: booking.paymentMethod,
      status: 'AVAILABLE',
    });

    await CompanyLedger.findOneAndUpdate(
      { bookingId: booking._id },
      {
        bookingId: booking._id,
        userId: booking.userId,
        mechanicId: booking.mechanicId,
        amount: booking.pricing?.companyEarning || 0,
        platformFeeAmount: booking.pricing?.platformFeeAmount || 0,
        gstAmount: booking.pricing?.gstAmount || 0,
        paymentMethod: 'ONLINE',
        status: 'SETTLED',
        razorpayOrderId: order_id,
        razorpayPaymentId: paymentId,
        settledAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Notify mechanic — payment received from customer's app
    const mechanicId = booking.mechanicId?.toString();
    if (mechanicId) {
      socketService.emitToMechanic(mechanicId, 'job:payment_confirmed', {
        bookingId: booking._id,
        bookingCode: booking.bookingId,
        amount: amountInRupees,
        mechanicEarning: booking.pricing?.mechanicEarning || 0,
        message: '✅ Customer paid online! You can now mark the job as complete.',
      });
    }

    return ApiResponse.success(res, { received: true }, 'Booking payment captured');
  }

  return ApiResponse.success(res, { received: true }, `Unhandled event ${event}`);
};

module.exports = {
  handleRazorpayWebhook,
};
