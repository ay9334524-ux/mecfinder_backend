const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const Service = require('../models/Service');
const RegionPricing = require('../models/RegionPricing');
const CompanyLedger = require('../models/CompanyLedger');
const CashSettlement = require('../models/CashSettlement');
const MechanicDebt = require('../models/MechanicDebt');
const Coupon = require('../models/Coupon');
const redisService = require('../services/redis.service');
const socketService = require('../services/socket.service');
const bookingQueueService = require('../services/bookingQueue.service');
const razorpayService = require('../services/razorpay.service');
const firebaseService = require('../services/firebase.service');
const notificationService = require('../services/notification.service');
const bookingEventEmitter = require('../services/bookingEventEmitter.service');
const cashflowSettlementService = require('../services/cashflowSettlement.service');
const walletController = require('./wallet.controller');
const notificationController = require('./notification.controller');
const earningsController = require('./earnings.controller');
const referralController = require('./referral.controller');
const rewardsController = require('./rewards.controller');
const ApiResponse = require('../utils/apiResponse');
const RedisLock = require('../utils/redisLock');
const { clampLimit, clampPage } = require('../utils/pagination');
const { asyncHandler } = require('../middleware/error.middleware');
const { computePriceComponents, pricingFromRegionOrPlain } = require('../utils/bookingPricing');

/**
 * Create a new booking
 * POST /api/booking
 * 
 * PRODUCTION-GRADE:
 * - Redis lock prevents double-click duplicate bookings
 * - Active booking check prevents user from having 2 concurrent bookings
 * - Idempotency key prevents retry-caused duplicates
 * - GeoJSON $nearSphere for optimal mechanic finding
 * - 5km → 10km tiered radius search
 */
const createBooking = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // ═══════════════════════════════════════════════════════════
  // 🔒 GUARD 1: Redis distributed lock (prevents double-click)
  // ═══════════════════════════════════════════════════════════
  const { acquired, lockValue } = await RedisLock.lockUserBooking(userId, 30);
  if (!acquired) {
    return ApiResponse.badRequest(res, 'A booking is already being processed. Please wait.');
  }

  try {
    // ═══════════════════════════════════════════════════════════
    // 🔒 GUARD 2: Check for active bookings (one at a time)
    // ═══════════════════════════════════════════════════════════
    const activeBooking = await Booking.findOne({
      userId,
      status: { $in: ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] },
    });

    if (activeBooking) {
      return ApiResponse.badRequest(
        res, 
        `You already have an active booking (${activeBooking.bookingId}). Complete or cancel it first.`
      );
    }

    const {
      serviceId,
      location,
      vehicleDetails,
      scheduledAt,
      notes,
      paymentMethod,
      promoCode,
      regionId,        // Optional: client can pass region context for accurate pricing
      idempotencyKey,  // Client can send a unique key to prevent duplicates on retry
    } = req.body;

    // ═══════════════════════════════════════════════════════════
    // 🔒 GUARD 3: Idempotency check (prevents retry duplicates)
    // ═══════════════════════════════════════════════════════════
    if (idempotencyKey) {
      const existingBooking = await Booking.findOne({ idempotencyKey });
      if (existingBooking) {
        return ApiResponse.success(res, {
          booking: {
            id: existingBooking._id,
            bookingId: existingBooking.bookingId,
            status: existingBooking.status,
          },
        }, 'Booking already exists (idempotent retry)');
      }
    }

    // Get service details
    const service = await Service.findById(serviceId).populate('categoryId');
    if (!service) {
      return ApiResponse.notFound(res, 'Service not found');
    }

    // Resolve region pricing. Prefer explicit regionId from the client, fall back
    // to the user's region (if stored on User), and finally to the first active
    // RegionPricing row for the service.
    let regionPricingDoc = null;
    const candidateRegionIds = [];
    if (regionId) candidateRegionIds.push(regionId);
    try {
      const userDoc = await User.findById(userId).select('regionId').lean();
      if (userDoc?.regionId) candidateRegionIds.push(userDoc.regionId);
    } catch (_) { /* user.regionId is optional */ }

    for (const rid of candidateRegionIds) {
      regionPricingDoc = await RegionPricing.findOne({ serviceId, regionId: rid, status: 'ACTIVE' });
      if (regionPricingDoc) break;
    }
    if (!regionPricingDoc) {
      // Fallback: any active region pricing for this service.
      regionPricingDoc = await RegionPricing.findOne({ serviceId, status: 'ACTIVE' });
    }

    const priceRow = regionPricingDoc
      ? pricingFromRegionOrPlain(regionPricingDoc)
      : computePriceComponents({
          basePrice: service.basePrice || 0,
          gstPercent: 18,
          platformFeePercent: 25,
          travelCharge: 88,
        });

    const basePrice = priceRow.basePrice;
    const gstAmount = priceRow.gstAmount;
    const platformFeeAmount = priceRow.platformFeeAmount;
    const travelCharge = priceRow.travelCharge;

    // ──────────────────────────────────────────────────────────────────────
    // 🏷️ Apply promo code (Coupon) — validates eligibility before discount
    // ──────────────────────────────────────────────────────────────────────
    let discount = 0;
    let appliedCoupon = null;
    if (promoCode && typeof promoCode === 'string' && promoCode.trim().length > 0) {
      const code = promoCode.trim().toUpperCase();
      const coupon = await Coupon.findOne({ code, isActive: true });
      if (!coupon) {
        return ApiResponse.badRequest(res, 'Invalid promo code');
      }
      const now = new Date();
      if (coupon.validFrom && now < coupon.validFrom) {
        return ApiResponse.badRequest(res, 'Promo code not active yet');
      }
      if (coupon.expiresAt && now > coupon.expiresAt) {
        return ApiResponse.badRequest(res, 'Promo code expired');
      }
      if (coupon.maxTotalUsage && coupon.currentUsage >= coupon.maxTotalUsage) {
        return ApiResponse.badRequest(res, 'Promo code usage limit reached');
      }
      const usagesByUser = (coupon.usageLog || []).filter(
        (u) => u.userId?.toString() === userId.toString()
      ).length;
      if (coupon.maxUsagePerUser && usagesByUser >= coupon.maxUsagePerUser) {
        return ApiResponse.badRequest(res, 'You have already used this promo code');
      }
      if (priceRow.totalAmount < (coupon.minOrderAmount || 0)) {
        return ApiResponse.badRequest(
          res,
          `Minimum order amount for this promo is ₹${coupon.minOrderAmount}`
        );
      }

      if (coupon.discountType === 'PERCENTAGE') {
        discount = Math.round((priceRow.totalAmount * coupon.discountValue) / 100);
      } else {
        discount = Math.round(coupon.discountValue);
      }
      if (coupon.maxDiscountAmount && discount > coupon.maxDiscountAmount) {
        discount = coupon.maxDiscountAmount;
      }
      // Never discount below zero, never exceed total.
      discount = Math.max(0, Math.min(discount, priceRow.totalAmount));
      appliedCoupon = coupon;
    }

    const totalAmount = Math.max(0, priceRow.totalAmount - discount);
    const mechanicEarning = priceRow.mechanicEarning;
    const companyEarning = priceRow.companyEarning - discount; // Discount comes from company share.

    // Generate 4-digit verification OTP
    const verificationOtp = Math.floor(1000 + Math.random() * 9000).toString();

    // Create booking — wrapped to translate the unique-index race on
    // idempotencyKey into the same "already exists" response. The earlier
    // check above is a fast path; this catch handles the TOCTOU window
    // where two concurrent retries with the same key both pass the check.
    let booking;
    try {
      booking = await Booking.create({
      userId,
      serviceId,
      idempotencyKey: idempotencyKey || undefined,
      serviceSnapshot: {
        name: service.name,
        categoryName: service.categoryId?.name,
        icon: service.icon,
      },
      location: {
        type: 'Point',
        coordinates: [location.longitude, location.latitude],
        address: location.address,
        landmark: location.landmark,
      },
      vehicleDetails,
      status: 'SEARCHING',
      searchStartedAt: new Date(),
      statusHistory: [{
        status: 'SEARCHING',
        timestamp: new Date(),
        note: 'Booking created, searching for nearby mechanics',
      }],
      pricing: {
        basePrice,
        gstPercent: regionPricingDoc?.gstPercent ?? priceRow.gstPercent,
        gstAmount,
        platformFeePercent: regionPricingDoc?.platformFeePercent ?? priceRow.platformFeePercent,
        platformFeeAmount,
        travelCharge,
        discount,
        promoCode,
        totalAmount,
        mechanicEarning,
        companyEarning,
      },
      paymentMethod: paymentMethod || 'CASH',
      scheduledAt,
      notes,
      verificationOtp,
      });
    } catch (createErr) {
      const isDuplicateKey = createErr?.code === 11000 &&
        (createErr?.keyPattern?.idempotencyKey || createErr?.message?.includes('idempotencyKey'));
      if (isDuplicateKey && idempotencyKey) {
        const existing = await Booking.findOne({ idempotencyKey });
        if (existing) {
          return ApiResponse.success(res, {
            booking: {
              id: existing._id,
              bookingId: existing.bookingId,
              status: existing.status,
            },
          }, 'Booking already exists (idempotent retry)');
        }
      }
      throw createErr;
    }

    // Record coupon usage (best-effort; we don't fail the booking on logging errors).
    if (appliedCoupon) {
      try {
        await Coupon.findByIdAndUpdate(appliedCoupon._id, {
          $inc: { currentUsage: 1 },
          $push: {
            usageLog: {
              userId,
              bookingId: booking._id,
              usedAt: new Date(),
              discountGiven: discount,
            },
          },
        });
      } catch (couponErr) {
        console.error('Failed to record coupon usage:', couponErr.message);
      }
    }

    // Send booking confirmation notification
    try {
      await notificationService.sendBookingConfirmationNotification(userId, booking);
    } catch (error) {
      console.error('Error sending booking confirmation notification:', error.message);
    }

  // ═══════════════════════════════════════════════════════════
  // 📍 FIND NEARBY MECHANICS (Production GeoJSON + Haversine fallback)
  // First try 10km, then expand to 20km if no mechanics found
  // ═══════════════════════════════════════════════════════════
  let nearbyMechanics = await findNearbyMechanics(
    location.latitude,
    location.longitude,
    vehicleDetails?.type || 'CAR',
    10
  );

  let searchRadius = 10;

  if (nearbyMechanics.length === 0) {
    nearbyMechanics = await findNearbyMechanics(
      location.latitude,
      location.longitude,
      vehicleDetails?.type || 'CAR',
      20
    );
    searchRadius = 20;
  }

    // Store dispatch metadata on booking
    booking.dispatchInfo = {
      totalMechanicsNotified: nearbyMechanics.length,
      searchRadiusKm: searchRadius,
    };
    await booking.save();

    if (nearbyMechanics.length > 0) {
      // Start round-robin queue — sends to one mechanic at a time.
      await bookingQueueService.startQueue(booking, nearbyMechanics);
    } else {
      await bookingQueueService.handleNoMechanicsAvailable(booking);
    }

    ApiResponse.created(res, {
      booking: {
        id: booking._id,
        bookingId: booking.bookingId,
        service: booking.serviceSnapshot,
        location: booking.location,
        pricing: booking.pricing,
        status: booking.status,
        verificationOtp: booking.verificationOtp,
        nearbyMechanicsCount: nearbyMechanics.length,
      },
    }, nearbyMechanics.length > 0 
      ? `Booking created. ${nearbyMechanics.length} mechanics notified.`
      : 'Booking created. Searching for mechanics...');
  } finally {
    // Always release the lock
    await RedisLock.release(`lock:user:booking:${userId}`, lockValue);
  }
});

/**
 * Get user's bookings
 * GET /api/booking
 */
const getUserBookings = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 10 });
  const skip = (page - 1) * limit;

  const filter = { userId: req.user.id };
  if (status) filter.status = status;

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('mechanicId', 'fullName phone ratingAverage profilePhoto'),
    Booking.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, bookings, {
    page,
    limit,
    total,
  });
});

/**
 * Get booking details
 * GET /api/booking/:id
 */
const getBookingDetails = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({
    _id: req.params.id,
    $or: [
      { userId: req.user?.id },
      { mechanicId: req.mechanic?.id },
    ],
  })
    .populate('userId', 'name phone profileImageUrl')
    .populate('mechanicId', 'fullName phone ratingAverage profilePhoto');

  if (!booking) {
    return ApiResponse.notFound(res, 'Booking not found');
  }

  ApiResponse.success(res, { booking });
});

/**
 * Cancel booking (user)
 * POST /api/booking/:id/cancel
 */
const cancelBooking = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const booking = await Booking.findOne({
    _id: req.params.id,
    userId: req.user.id,
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Booking not found');
  }

  // User can cancel BEFORE work starts (IN_PROGRESS)
  // Once OTP is verified and work begins, cannot cancel
  const cancellableStatuses = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED'];
  if (!cancellableStatuses.includes(booking.status)) {
    return ApiResponse.badRequest(res, 'Cannot cancel after service has started. Please contact support.');
  }

  const oldStatus = booking.status;

  booking.status = 'CANCELLED';
  booking.cancelledBy = 'USER';
  booking.cancellationReason = reason || 'Cancelled by user';
  booking.cancelledAt = new Date();
  await booking.save();

  // Emit booking cancelled event
  bookingEventEmitter.emitBookingStatusChange(booking, oldStatus, booking.mechanicId);

  // Send socket event to User so their app resets state immediately
  socketService.emitToUser(booking.userId.toString(), 'booking:cancelled', {
    bookingId: booking._id,
    bookingNumber: booking.bookingId,
    cancelledBy: 'user',
    reason: reason || 'Cancelled by user',
  });

  // Process refund if payment was made
  if (booking.paymentStatus === 'PAID' || booking.paymentStatus === 'PARTIALLY_PAID') {
    // Only refund if actual wallet/online money was paid. Cash hasn't been collected.
    if (booking.paymentDetails?.walletAmount > 0 || booking.paymentDetails?.onlineAmount > 0) {
      if (booking.paymentDetails?.walletAmount > 0) {
        await walletController.creditRefund(
          req.user.id,
          booking.paymentDetails.walletAmount,
          booking._id.toString(),
          'Booking cancellation refund'
        );
      }
      booking.paymentStatus = 'REFUNDED';
      await booking.save();
    }
  }

  // Notify mechanic if assigned
  if (booking.mechanicId) {
    // Send socket update
    socketService.emitToMechanic(booking.mechanicId.toString(), 'booking:cancelled', {
      bookingId: booking._id,
      bookingNumber: booking.bookingId,
      cancelledBy: 'user',
      reason: reason || 'Customer cancelled the booking',
    });

    // Release mechanic (make them available for new bookings)
    await bookingQueueService.releaseMechanic(booking.mechanicId.toString());

    await notificationController.sendJobNotification(
      booking.mechanicId,
      'Booking Cancelled',
      'Customer has cancelled the booking',
      booking._id,
      'NORMAL'
    );
  }

  // If booking was still searching, cleanup the queue and release all offer locks
  if (['PENDING', 'SEARCHING'].includes(oldStatus)) {
    await bookingQueueService.cleanupQueue(booking._id.toString());
  }

  ApiResponse.success(res, { booking }, 'Booking cancelled successfully');
});

/**
 * Rate booking (user)
 * POST /api/booking/:id/rate
 */
const rateBooking = asyncHandler(async (req, res) => {
  const { rating, review } = req.body;

  const booking = await Booking.findOne({
    _id: req.params.id,
    userId: req.user.id,
    status: 'COMPLETED',
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Booking not found or not completed');
  }

  if (booking.rating) {
    return ApiResponse.badRequest(res, 'Booking already rated');
  }

  booking.rating = rating;
  booking.review = review;
  booking.ratedAt = new Date();
  await booking.save();

  // Update mechanic rating
  if (booking.mechanicId) {
    const mechanic = await Mechanic.findById(booking.mechanicId);
    const newCount = mechanic.ratingCount + 1;
    const newAverage = ((mechanic.ratingAverage * mechanic.ratingCount) + rating) / newCount;
    
    mechanic.ratingAverage = Math.round(newAverage * 10) / 10;
    mechanic.ratingCount = newCount;
    await mechanic.save();
  }

  // Add reward points for review
  await rewardsController.addReviewPoints(req.user.id, booking._id.toString());

  ApiResponse.success(res, { booking }, 'Thank you for your feedback!');
});

// Mechanic endpoints

/**
 * Get mechanic's jobs
 * GET /api/mechanic/jobs
 */
const getMechanicJobs = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 10 });
  const skip = (page - 1) * limit;

  const filter = { mechanicId: req.mechanic.id };

  if (status === 'active') {
    filter.status = { $in: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] };
  } else if (status === 'completed') {
    filter.status = 'COMPLETED';
  } else if (status === 'cancelled') {
    filter.status = 'CANCELLED';
  }

  const [jobs, total] = await Promise.all([
    Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name phone'),
    Booking.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, jobs, {
    page,
    limit,
    total,
  });
});

/**
 * Get current active booking for mechanic
 * GET /api/mechanic/bookings/current
 */
const getCurrentBooking = asyncHandler(async (req, res) => {
  // Find current active booking (ASSIGNED or IN_PROGRESS)
  const booking = await Booking.findOne({
    mechanicId: req.mechanic.id,
    status: { $in: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] },
  })
    .sort({ createdAt: -1 })
    .populate('userId', 'name phone profilePhoto')
    .populate('serviceId', 'name categoryName');

  if (!booking) {
    // No active booking found
    return ApiResponse.notFound(res, 'No active booking found');
  }

  ApiResponse.success(res, { booking });
});

/**
 * Get mechanic booking history (completed and cancelled)
 * GET /api/mechanic/bookings/history?status=COMPLETED|CANCELLED
 */
const getMechanicBookingHistory = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 20 });
  const skip = (page - 1) * limit;

  const filter = { mechanicId: req.mechanic.id };

  if (status === 'COMPLETED') {
    filter.status = 'COMPLETED';
  } else if (status === 'CANCELLED') {
    filter.status = 'CANCELLED';
  } else {
    // Default: both completed and cancelled
    filter.status = { $in: ['COMPLETED', 'CANCELLED'] };
  }

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .sort({ completedAt: -1, cancelledAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('userId', 'name phone profilePhoto'),
    Booking.countDocuments(filter),
  ]);

  ApiResponse.success(res, {
    bookings,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

/**
 * Accept job (mechanic) — HTTP fallback for `booking:accept` socket event.
 *
 * The canonical accept path is the queue service (`handleMechanicAccept` which
 * transitions PENDING/SEARCHING -> ACCEPTED). This endpoint mirrors that
 * behaviour so REST and Socket flows are consistent. It also supports the
 * legacy ASSIGNED status for backward compatibility.
 *
 * Uses atomic update to prevent race conditions when multiple mechanics try
 * to accept.
 */
const acceptJob = asyncHandler(async (req, res) => {
  // ═══════ DEBT CHECK — Block acceptance if mechanic has active debt ═══════
  const mechanic = await Mechanic.findById(req.mechanic.id).select('hasActiveDebt');
  if (mechanic?.hasActiveDebt) {
    const totalDebt = await MechanicDebt.getTotalActiveDebt(req.mechanic.id);
    if (totalDebt > 0) {
      return ApiResponse.forbidden(res, `Clear ₹${totalDebt} pending dues before accepting new jobs`);
    } else {
      await Mechanic.findByIdAndUpdate(req.mechanic.id, { hasActiveDebt: false });
    }
  }
  // ═══════════════════════════════════════════════════════════════════════════

  // Prefer the queue-service path so REST + Socket converge on the same logic.
  const queueResult = await bookingQueueService.handleMechanicAccept(req.params.id, req.mechanic.id);
  if (queueResult.success) {
    const acceptedBooking = await Booking.findById(req.params.id);
    return ApiResponse.success(res, { booking: acceptedBooking }, 'Job accepted');
  }

  // Fallback: direct atomic accept (no active queue / legacy ASSIGNED path).
  const booking = await Booking.findOneAndUpdate(
    {
      _id: req.params.id,
      $or: [
        // Legacy direct-assignment path
        { mechanicId: req.mechanic.id, status: 'ASSIGNED' },
        // Queue path where this mechanic was the current offer recipient
        { status: { $in: ['PENDING', 'SEARCHING'] }, mechanicId: null },
      ],
    },
    {
      $set: {
        mechanicId: req.mechanic.id,
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
      $push: {
        statusHistory: {
          status: 'ACCEPTED',
          timestamp: new Date(),
          note: 'Job accepted by mechanic (HTTP fallback)',
        },
      },
    },
    { new: true }
  );

  if (!booking) {
    return ApiResponse.notFound(res, 'Job not found or already processed by another mechanic');
  }

  // Mark mechanic as busy so they aren't offered other jobs.
  await Mechanic.findByIdAndUpdate(req.mechanic.id, {
    $set: { isBusy: true, currentBookingId: booking._id, lastActiveAt: new Date() },
    $inc: { totalOffersReceived: 1, totalOffersAccepted: 1 },
  });

  const mechanicData = await Mechanic.findById(req.mechanic.id);
  bookingEventEmitter.emitBookingStatusChange(booking, 'ASSIGNED', mechanicData);

  await notificationController.sendBookingNotification(
    booking.userId,
    'Mechanic Assigned',
    'A mechanic has accepted your booking and will arrive soon',
    booking._id
  );

  // Notify user via socket
  socketService.emitToUser(booking.userId.toString(), 'booking:accepted', {
    bookingId: booking._id,
    mechanicId: req.mechanic.id,
    message: 'A mechanic has accepted your request!',
  });

  ApiResponse.success(res, { booking }, 'Job accepted');
});

/**
 * Update job status (mechanic)
 * PUT /api/mechanic/job/:id/status
 */
const updateJobStatus = asyncHandler(async (req, res) => {
  const { status, otp } = req.body;

  if (!status) {
    return ApiResponse.badRequest(res, 'Status is required');
  }

  const booking = await Booking.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Job not found');
  }

  // Validate status transition
  const validTransitions = {
    'ASSIGNED': ['EN_ROUTE', 'ARRIVED', 'CANCELLED'],
    'ACCEPTED': ['EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'CANCELLED'], // Allow direct IN_PROGRESS with OTP
    'EN_ROUTE': ['ARRIVED', 'IN_PROGRESS', 'CANCELLED'], // Allow skipping ARRIVED if OTP provided
    'ARRIVED': ['IN_PROGRESS', 'CANCELLED'],
    'IN_PROGRESS': ['COMPLETED'],
  };

  const allowedTransitions = validTransitions[booking.status];
  if (!allowedTransitions || !allowedTransitions.includes(status)) {
    return ApiResponse.badRequest(res, `Cannot change status from ${booking.status} to ${status}`);
  }

  // Verify OTP to START work (any status -> IN_PROGRESS)
  if (status === 'IN_PROGRESS') {
    if (!booking.verificationOtp) {
      return ApiResponse.badRequest(res, 'No verification OTP found for this booking');
    }
    if (!otp) {
      return ApiResponse.badRequest(res, 'OTP is required to start service');
    }
    const providedOtp = String(otp).trim();
    const storedOtp = String(booking.verificationOtp).trim();
    if (providedOtp !== storedOtp) {
      return ApiResponse.badRequest(res, `Invalid OTP. Please ask customer for the correct 4-digit OTP.`);
    }
    booking.otpVerifiedAt = new Date();
    booking.startedAt = new Date();
  }

  // Set timestamps for each status
  if (status === 'EN_ROUTE') booking.enRouteAt = new Date();
  if (status === 'ARRIVED') booking.arrivedAt = new Date();
  if (status === 'COMPLETED') booking.completedAt = new Date();

  await booking.updateStatus(status);

  // Send notifications and emit socket events
  const notificationMessages = {
    'EN_ROUTE': { title: 'Mechanic On The Way', body: 'The mechanic is heading to your location' },
    'ARRIVED': { title: 'Mechanic Arrived', body: 'The mechanic has arrived. Share the OTP to start service.' },
    'IN_PROGRESS': { title: 'Work Started', body: 'The mechanic has verified OTP and started working on your vehicle' },
    'COMPLETED': { title: 'Service Completed', body: 'Your service has been completed. Please proceed with payment.' },
  };

  if (notificationMessages[status]) {
    await notificationController.sendBookingNotification(
      booking.userId,
      notificationMessages[status].title,
      notificationMessages[status].body,
      booking._id
    );
  }

  // Emit booking event for service status changes
  const mechanic = await Mechanic.findById(req.mechanic.id);
  if (status === 'IN_PROGRESS') {
    bookingEventEmitter.emitBookingStatusChange(booking, 'ARRIVED', mechanic);
  } else if (status === 'COMPLETED') {
    bookingEventEmitter.emitBookingStatusChange(booking, 'IN_PROGRESS', mechanic);
  }

  // Emit socket event for real-time updates
  socketService.emitToUser(booking.userId.toString(), 'booking:status', {
    bookingId: booking._id,
    status,
    message: notificationMessages[status]?.body || `Status changed to ${status}`,
    // Send OTP display flag when arrived
    showOtp: status === 'ARRIVED',
  });

  // On completion, set payment status to PENDING (not PAID yet)
  if (status === 'COMPLETED') {
    booking.paymentStatus = 'PENDING';
    await booking.save();

    // Notify mechanic to collect payment
    socketService.emitToMechanic(booking.mechanicId?.toString(), 'booking:collect_payment', {
      bookingId: booking._id,
      bookingCode: booking.bookingId,
      amount: booking.pricing.totalAmount,
      customerName: booking.serviceSnapshot?.name,
    });
  }

  ApiResponse.success(res, { booking }, `Status updated to ${status}`);
});

/**
 * Confirm payment collected by mechanic
 * POST /api/mechanic/job/:id/confirm-payment
 */
const confirmPayment = asyncHandler(async (req, res) => {
  const { paymentMethod, transactionId } = req.body; // CASH or UPI
  
  // Allow confirm payment for IN_PROGRESS or COMPLETED status
  const booking = await Booking.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
    status: { $in: ['IN_PROGRESS', 'COMPLETED'] },
  });

  if (!booking) {
    // Try to find any booking with this ID to give better error
    const anyBooking = await Booking.findById(req.params.id);
    if (!anyBooking) {
      return ApiResponse.notFound(res, 'Booking not found');
    }
    if (anyBooking.mechanicId?.toString() !== req.mechanic.id) {
      return ApiResponse.notFound(res, 'This job is not assigned to you');
    }
    return ApiResponse.notFound(res, `Job cannot be completed. Current status: ${anyBooking.status}`);
  }

  if (booking.paymentStatus === 'PAID') {
    return ApiResponse.badRequest(res, 'Payment already confirmed');
  }

  // SECURITY: for online (UPI) payments we no longer trust a self-declared
  // transactionId. Online payments MUST be confirmed via the verified
  // Razorpay flow (verifyBookingPayment) or via the Razorpay webhook
  // (payment_link.paid / payment.captured). This endpoint is for CASH only.
  if (paymentMethod && paymentMethod !== 'CASH') {
    return ApiResponse.badRequest(
      res,
      'Online payments must be verified via Razorpay (UPI link / order). Use the verify-payment endpoint or share the Razorpay payment link with the customer.'
    );
  }
  const effectivePaymentMethod = 'CASH';

  // Enforce cash limit policy
  const cashLimitPolicyService = require('../services/cashLimitPolicy.service');
  const cashCheck = await cashLimitPolicyService.canAcceptCashJob(req.mechanic.id);
  if (!cashCheck.allowed) {
    return ApiResponse.badRequest(res, cashCheck.message || 'Cash job limit reached. Please use online payment.');
  }

  // If status is IN_PROGRESS, mark as COMPLETED first
  if (booking.status === 'IN_PROGRESS') {
    booking.status = 'COMPLETED';
    booking.completedAt = new Date();
    // Initialize statusHistory if undefined
    if (!booking.statusHistory) {
      booking.statusHistory = [];
    }
    booking.statusHistory.push({
      status: 'COMPLETED',
      timestamp: new Date(),
      notes: 'Completed with payment collection',
    });
  }

  // Update payment details (CASH only at this endpoint)
  booking.paymentStatus = 'PAID';
  booking.paymentMethod = effectivePaymentMethod;
  booking.paymentDetails = {
    ...booking.paymentDetails,
    collectedByMechanic: true,
    paymentMethod: effectivePaymentMethod,
    transactionId: null,
    cashAmount: booking.pricing?.totalAmount,
    onlineAmount: 0,
    collectedAt: new Date(),
  };
  
  try {
    await booking.save();
  } catch (saveError) {
    console.error('Booking save error:', saveError.message);
    return ApiResponse.error(res, 'Failed to save booking: ' + saveError.message, 422);
  }

  await CompanyLedger.findOneAndUpdate(
    { bookingId: booking._id },
    {
      bookingId: booking._id,
      userId: booking.userId,
      mechanicId: booking.mechanicId,
      amount: booking.pricing?.companyEarning || 0,
      platformFeeAmount: booking.pricing?.platformFeeAmount || 0,
      gstAmount: booking.pricing?.gstAmount || 0,
      paymentMethod: 'CASH',
      status: 'DUE',
    },
    { upsert: true, new: true }
  );

  // ════════════════════════════════════════════════════════════
  // 💰 AUTO CASHFLOW SETTLEMENT
  // ════════════════════════════════════════════════════════════
  if (effectivePaymentMethod === 'CASH') {
    // CASH: Create debt record (mechanic wallet goes NEGATIVE)
    await cashflowSettlementService.handleCashPaymentSettlement(booking);

    await CashSettlement.findOneAndUpdate(
      { bookingId: booking._id },
      {
        bookingId: booking._id,
        mechanicId: booking.mechanicId,
        amountDue: booking.pricing?.companyEarning || 0,
        paymentMethod: 'CASH',
        transactionId: null,
        collectedAt: new Date(),
        status: 'DUE',
        notes: 'CASH - debt created, will auto-deduct from next online payment',
      },
      { upsert: true, new: true }
    );
  }

  // Create earning for mechanic (with null checks)
  try {
    const user = await User.findById(booking.userId);
    
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
      customerName: user?.name || 'Customer',
      customerPhone: user?.phone || '',
      location: {
        address: booking.location?.address || '',
      },
      paymentMethod: effectivePaymentMethod,
      // CASH: put earning ON_HOLD so wallet shows NEGATIVE (only debt is counted)
      // Earning becomes AVAILABLE after mechanic clears the debt
      status: 'ON_HOLD',
    });

    // Update mechanic's total jobs and check for title progression
    const mechanic = await Mechanic.findById(booking.mechanicId);
    if (mechanic) {
      mechanic.totalJobsCompleted = (mechanic.totalJobsCompleted || 0) + 1;
      
      // Determine new title based on total jobs
      const getTitleForJobs = (totalJobs) => {
        if (totalJobs <= 5) return 'NEW';
        if (totalJobs <= 25) return 'BEGINNER';
        if (totalJobs <= 50) return 'INTERMEDIATE';
        if (totalJobs <= 100) return 'BRONZE';
        if (totalJobs <= 150) return 'SILVER';
        if (totalJobs <= 200) return 'GOLD';
        if (totalJobs <= 250) return 'PLATINUM';
        if (totalJobs <= 300) return 'DIAMOND';
        if (totalJobs <= 400) return 'ACE';
        if (totalJobs <= 500) return 'CONQUEROR';
        return 'MASTER';
      };

      const newTitle = getTitleForJobs(mechanic.totalJobsCompleted);
      const previousTitle = mechanic.currentTitle || 'NEW';
      
      // Check if title changed
      if (newTitle !== previousTitle) {
        mechanic.currentTitle = newTitle;
        mechanic.titleUnlockHistory.push({
          title: newTitle,
          unlockedAt: new Date(),
          jobsCompletedAtUnlock: mechanic.totalJobsCompleted
        });

        // Emit socket event for new title unlock
        socketService.emitToMechanic(booking.mechanicId.toString(), 'title:unlocked', {
          newTitle: newTitle,
          previousTitle: previousTitle,
          totalJobsCompleted: mechanic.totalJobsCompleted,
          message: `🎉 Congratulations! You've unlocked the ${newTitle} title!`
        });
      }

      await mechanic.save();
    }
  } catch (earningError) {
    console.error('⚠️ Earning creation failed (non-blocking):', earningError.message);
    // Don't fail the whole request - payment is confirmed, earning can be created later
  }

  // Check if this is user's first booking (for referral)
  const userBookingCount = await Booking.countDocuments({
    userId: booking.userId,
    status: 'COMPLETED',
    paymentStatus: 'PAID',
  });

  if (userBookingCount === 1) {
    await referralController.completeReferral(booking.userId.toString());
    await rewardsController.addPoints(
      booking.userId.toString(),
      'FIRST_BOOKING_BONUS',
      booking._id.toString(),
      'First booking bonus'
    );
  }

  // Add booking points for user
  await rewardsController.addBookingPoints(booking.userId.toString(), booking._id.toString());

  // Notify user that payment was received
  await notificationController.sendBookingNotification(
    booking.userId,
    'Service Completed',
    `Your service has been completed. Payment of ₹${booking.pricing?.totalAmount || 0} confirmed. Please rate your experience!`,
    booking._id
  );

  // Emit status update to user so their app updates
  socketService.emitToUser(booking.userId.toString(), 'booking:status', {
    bookingId: booking._id,
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    message: 'Service completed successfully',
  });

  // Emit to mechanic to update their UI - booking is now fully complete
  socketService.emitToMechanic(booking.mechanicId.toString(), 'booking:completed', {
    bookingId: booking._id,
    status: 'COMPLETED',
    paymentStatus: 'PAID',
    message: 'Payment confirmed. Job is complete!',
  });

  // Emit to user to show rating prompt
  socketService.emitToUser(booking.userId.toString(), 'booking:payment_confirmed', {
    bookingId: booking._id,
    amount: booking.pricing?.totalAmount || 0,
    showRatingPrompt: true,
  });

  // 🔓 RELEASE MECHANIC — make them available for new bookings
  await bookingQueueService.releaseMechanic(booking.mechanicId?.toString());

  ApiResponse.success(res, { booking }, 'Payment confirmed successfully');
});

/**
 * Reject job (mechanic) — HTTP fallback for the `booking:reject` socket event.
 *
 * If the booking has an active queue, defer to the queue service which will
 * immediately skip to the next mechanic. Otherwise, reset the booking back to
 * SEARCHING and (best effort) start a fresh dispatch.
 *
 * POST /api/mechanic/job/:id/reject
 */
const rejectJob = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  // Prefer queue service path
  const queueStatus = bookingQueueService.getQueueStatus(req.params.id);
  if (queueStatus) {
    await bookingQueueService.handleMechanicReject(req.params.id, req.mechanic.id, reason || 'rejected');
    return ApiResponse.success(res, null, 'Job rejected');
  }

  // Legacy path: booking was directly assigned and is sitting in ASSIGNED.
  const booking = await Booking.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
    status: { $in: ['ASSIGNED', 'ACCEPTED'] },
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Job not found or already processed');
  }

  // Track rejection stats.
  await Mechanic.findByIdAndUpdate(req.mechanic.id, {
    $inc: { totalOffersReceived: 1 },
  }).catch(() => {});

  // Unassign and re-broadcast.
  booking.mechanicId = null;
  booking.status = 'SEARCHING';
  booking.searchStartedAt = new Date();
  if (!booking.excludedMechanicIds) booking.excludedMechanicIds = [];
  if (!booking.excludedMechanicIds.some((id) => id?.toString() === req.mechanic.id.toString())) {
    booking.excludedMechanicIds.push(req.mechanic.id);
  }
  booking.statusHistory.push({
    status: 'SEARCHING',
    timestamp: new Date(),
    note: reason ? `Rejected by mechanic: ${reason}` : 'Rejected by mechanic — re-searching',
  });
  await booking.save();

  // Free the mechanic so they can receive other offers.
  await bookingQueueService.releaseMechanic(req.mechanic.id);

  // Best-effort: kick off a new search from current booking location.
  try {
    const lat = booking.location?.coordinates?.[1];
    const lng = booking.location?.coordinates?.[0];
    const vehicleType = booking.vehicleDetails?.type || 'CAR';
    const excludeIds = (booking.excludedMechanicIds || []).map((id) => id.toString());
    if (lat != null && lng != null) {
      let nearby = await findNearbyMechanics(lat, lng, vehicleType, 10, { excludeIds });
      if (nearby.length === 0) {
        nearby = await findNearbyMechanics(lat, lng, vehicleType, 20, { excludeIds });
      }
      if (nearby.length > 0) {
        await bookingQueueService.startQueue(booking, nearby);
      } else {
        await bookingQueueService.handleNoMechanicsAvailable(booking);
      }
    }
  } catch (err) {
    console.error('Re-queue after reject failed:', err.message);
  }

  ApiResponse.success(res, null, 'Job rejected');
});

/**
 * Cancel job by mechanic (after accepting but before completion)
 * POST /api/mechanic/job/:id/cancel
 */
const cancelJobByMechanic = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const booking = await Booking.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
    // Mechanic can cancel BEFORE starting work (before OTP verification)
    // Cannot cancel once IN_PROGRESS
    status: { $in: ['ASSIGNED', 'ACCEPTED', 'EN_ROUTE', 'ARRIVED'] },
  }).populate('userId', 'phone fcmToken');

  if (!booking) {
    // Check if booking exists but in wrong status
    const existingBooking = await Booking.findById(req.params.id);
    if (existingBooking?.status === 'IN_PROGRESS') {
      return ApiResponse.badRequest(res, 'Cannot cancel after work has started. Please complete the job.');
    }
    return ApiResponse.notFound(res, 'Job not found or cannot be cancelled at this stage');
  }

  // Update booking status
  booking.status = 'CANCELLED';
  booking.cancelledBy = 'MECHANIC';
  booking.cancellationReason = reason || 'Cancelled by mechanic';
  booking.cancelReason = reason || 'Cancelled by mechanic';
  booking.cancelledAt = new Date();
  await booking.save();

  // Set mechanic as not busy (production: release via queue service)
  await bookingQueueService.releaseMechanic(req.mechanic.id);

  // Notify user via socket
  if (socketService.isConnected) {
    socketService.emitToUser(booking.userId._id.toString(), 'booking:cancelled', {
      bookingId: booking._id,
      bookingNumber: booking.bookingId,
      cancelledBy: 'mechanic',
      reason: reason || 'Mechanic cancelled the service',
    });
  }

  // Send push notification to user (best-effort — never fail cancellation
  // because of a stale FCM token).
  if (booking.userId?.fcmToken) {
    try {
      await firebaseService.sendBookingCancellationNotification(
        booking.userId.fcmToken,
        {
          bookingId: booking._id.toString(),
          serviceName: booking.serviceSnapshot?.name || 'Service',
          reason: reason || 'Mechanic cancelled the service',
          cancelledBy: 'mechanic',
        },
        'user'
      );
    } catch (fcmError) {
      if (fcmError.code === 'INVALID_FCM_TOKEN') {
        await User.findByIdAndUpdate(booking.userId._id, { $unset: { fcmToken: 1 } })
          .catch(() => {});
      } else {
        console.warn('FCM cancel-notify failed:', fcmError.message);
      }
    }
  }

  // Create notification for user
  await notificationController.createNotification(
    booking.userId._id,
    'USER',
    'BOOKING_CANCELLED',
    'Booking Cancelled',
    `Your booking #${booking.bookingId} has been cancelled by the mechanic.`,
    { bookingId: booking._id }
  );

  ApiResponse.success(res, null, 'Job cancelled successfully');
});

/**
 * Get booking history (user)
 * GET /api/booking/history
 */
const getBookingHistory = asyncHandler(async (req, res) => {
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 10 });
  const skip = (page - 1) * limit;

  const [bookings, total] = await Promise.all([
    Booking.find({
      userId: req.user.id,
      status: { $in: ['COMPLETED', 'CANCELLED'] },
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('mechanicId', 'fullName ratingAverage profilePhoto'),
    Booking.countDocuments({
      userId: req.user.id,
      status: { $in: ['COMPLETED', 'CANCELLED'] },
    }),
  ]);

  ApiResponse.paginated(res, bookings, {
    page,
    limit,
    total,
  });
});

/**
 * Debug endpoint to check nearby mechanics
 * GET /api/booking/check-mechanics?lat=XX&lng=XX&vehicleType=CAR
 */
const checkNearbyMechanics = asyncHandler(async (req, res) => {
  const { lat, lng, vehicleType = 'CAR' } = req.query;
  
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  
  if (!latitude || !longitude) {
    return ApiResponse.badRequest(res, 'lat and lng query parameters are required');
  }
  
  console.log(`🔍 [DEBUG] Checking mechanics near: ${latitude}, ${longitude} for ${vehicleType}`);
  
  // Get all mechanics counts for debugging
  const totalMechanics = await Mechanic.countDocuments({});
  const activeMechanics = await Mechanic.countDocuments({ status: 'ACTIVE' });
  const onlineMechanics = await Mechanic.countDocuments({ status: 'ACTIVE', isOnline: true });
  const availableMechanics = await Mechanic.countDocuments({ 
    status: 'ACTIVE', 
    isOnline: true, 
    isBusy: false,
    currentBookingId: null 
  });
  const withVehicleType = await Mechanic.countDocuments({ 
    status: 'ACTIVE', 
    isOnline: true, 
    isBusy: false,
    currentBookingId: null,
    vehicleTypes: vehicleType
  });
  
  // Find nearby mechanics
  const nearbyMechanics = await findNearbyMechanics(latitude, longitude, vehicleType, 10);
  
  // Get list of all online mechanics for debugging
  const allOnline = await Mechanic.find({ isOnline: true })
    .select('fullName status isOnline isBusy currentBookingId vehicleTypes lastLocation location')
    .limit(10);
  
  ApiResponse.success(res, {
    query: { latitude, longitude, vehicleType },
    counts: {
      totalMechanics,
      activeMechanics,
      onlineMechanics,
      availableMechanics,
      withVehicleType
    },
    nearbyMechanicsFound: nearbyMechanics.length,
    nearbyMechanics: nearbyMechanics.map(m => ({
      id: m._id,
      name: m.fullName,
      distance: m.distance?.toFixed(2) + 'km',
      vehicleTypes: m.vehicleTypes
    })),
    allOnlineMechanics: allOnline.map(m => ({
      id: m._id,
      name: m.fullName,
      status: m.status,
      isOnline: m.isOnline,
      isBusy: m.isBusy,
      hasBooking: !!m.currentBookingId,
      vehicleTypes: m.vehicleTypes,
      hasLocation: !!(m.location?.coordinates?.length || (m.lastLocation?.lat && m.lastLocation?.lng))
    })),
    debug: {
      issue: activeMechanics === 0 
        ? 'No ACTIVE mechanics. Mechanics need admin approval.' 
        : onlineMechanics === 0 
        ? 'No online mechanics. Mechanics need to go online.' 
        : availableMechanics === 0 
        ? 'All mechanics are busy or have bookings.'
        : nearbyMechanics.length === 0
        ? 'Mechanics are available but none are within 10km of your location.'
        : 'Mechanics are available!'
    }
  });
});

/**
 * Find nearby mechanics using a composite scoring system.
 *
 * Strategy:
 * 1. Geo-query via MongoDB $nearSphere (2dsphere index, O(log n))
 * 2. Haversine fallback for mechanics on legacy schema (no GeoJSON)
 * 3. Score each candidate: proximity × rating × availability
 * 4. Filter out mechanics currently receiving another booking offer
 *    (prevents two simultaneous bookings being dispatched to the same mechanic)
 *
 * Score formula (higher = better):
 *   score = 0.6 × proximityScore + 0.3 × ratingScore + 0.1 × experienceScore
 *
 *   proximityScore  = exp(-distance / 2)       → halves every 2km
 *   ratingScore     = rating / 5               → normalised 0→1
 *   experienceScore = min(jobs / 100, 1)       → caps at 100 jobs
 *
 * Returns: Top 20 mechanics sorted by score (best first).
 */
async function findNearbyMechanics(latitude, longitude, vehicleType, radiusKm = 5, options = {}) {
  try {
    const { excludeIds = [] } = options;
    console.log(`🔍 Scoring mechanics: lat=${latitude}, lng=${longitude}, vehicle=${vehicleType}, radius=${radiusKm}km, exclude=${excludeIds.length}`);

    const radiusMeters = radiusKm * 1000;
    const excludeObjectIds = excludeIds
      .map((id) => {
        try { return new mongoose.Types.ObjectId(id); } catch { return null; }
      })
      .filter(Boolean);

    // Vehicle type is a HARD filter. We never silently fall back to "any
    // vehicle" — sending a CAR job to a BIKE-only mechanic would let them
    // accept work they cannot service.
    const baseFilter = {
      status: 'ACTIVE',
      isOnline: true,
      isBusy: false,
      hasActiveDebt: false,
      currentBookingId: null,
      vehicleTypes: vehicleType,
    };
    if (excludeObjectIds.length > 0) {
      baseFilter._id = { $nin: excludeObjectIds };
    }

    // ═══════════════════════════════════════════════════════════
    // PRIMARY: MongoDB $nearSphere with 2dsphere index
    // ═══════════════════════════════════════════════════════════
    let mechanics = [];

    try {
      mechanics = await Mechanic.find({
        ...baseFilter,
        location: {
          $nearSphere: {
            $geometry: { type: 'Point', coordinates: [longitude, latitude] },
            $maxDistance: radiusMeters,
          },
        },
      })
        .select('_id fullName phone profilePhoto ratingAverage totalJobsCompleted totalOffersReceived totalOffersAccepted location lastLocation fcmToken vehicleTypes address')
        .limit(30);

      console.log(`📋 [GeoJSON] Found ${mechanics.length} mechanics within ${radiusKm}km for ${vehicleType}`);
    } catch (geoError) {
      console.warn(`⚠️ GeoJSON $nearSphere failed: ${geoError.message}`);
      mechanics = [];
    }

    // ═══════════════════════════════════════════════════════════
    // FALLBACK: Haversine (legacy lastLocation schema)
    // ═══════════════════════════════════════════════════════════
    if (mechanics.length === 0) {
      console.log(`🔄 GeoJSON returned 0 — trying Haversine fallback...`);

      const legacyQuery = {
        ...baseFilter,
        'lastLocation.lat': { $exists: true, $ne: null },
        'lastLocation.lng': { $exists: true, $ne: null },
      };

      const legacyMechanics = await Mechanic.find(legacyQuery)
        .select('_id fullName phone profilePhoto ratingAverage totalJobsCompleted totalOffersReceived totalOffersAccepted lastLocation fcmToken vehicleTypes address')
        .limit(60);

      console.log(`📋 [Haversine] ${legacyMechanics.length} online ${vehicleType} mechanics found`);

      const withDistance = legacyMechanics
        .map(m => ({
          ...m.toObject(),
          distance: calculateDistance(latitude, longitude, m.lastLocation?.lat, m.lastLocation?.lng),
        }))
        .filter(m => m.distance !== null && m.distance <= radiusKm);

      const reachable = await _filterReachable(withDistance);
      return _scoreAndRank(reachable, 20);
    }

    // Attach Haversine distances to GeoJSON results (for scoring)
    const withDistance = mechanics.map(m => {
      const mLat = m.location?.coordinates?.[1] ?? m.lastLocation?.lat;
      const mLng = m.location?.coordinates?.[0] ?? m.lastLocation?.lng;
      return {
        ...m.toObject(),
        distance: calculateDistance(latitude, longitude, mLat, mLng),
      };
    });

    const reachable = await _filterReachable(withDistance);
    return _scoreAndRank(reachable, 20);
  } catch (err) {
    console.error('❌ findNearbyMechanics error:', err.message);
    return [];
  }
}

/**
 * Drop "ghost-online" mechanics: those whose DB `isOnline` flag is true but
 * who have no live socket on this server and no fresh Redis presence. They
 * can't actually receive a dispatch in real-time, so queueing them just
 * burns 25 s of the user's wait time per ghost.
 *
 * A mechanic is kept if EITHER:
 *   • we hold an open socket for them on this process, OR
 *   • Redis has their presence key (multi-server safe).
 *
 * We intentionally do NOT flip `isOnline` in Mongo here — mis-detecting
 * presence once would strand mechanics offline until manual toggle.
 */
async function _filterReachable(mechanics) {
  if (!mechanics || mechanics.length === 0) return [];

  const reachable = [];
  const ghosts = [];

  await Promise.all(
    mechanics.map(async (m) => {
      const id = m._id?.toString() || m.id?.toString();
      if (!id) return;
      const ok = await socketService.isMechanicReachable(id);
      if (ok) {
        reachable.push(m);
      } else {
        ghosts.push({ id, name: m.fullName || 'Unknown' });
      }
    }),
  );

  if (ghosts.length > 0) {
    console.log(
      `👻 Filtered ${ghosts.length} unreachable mechanic(s) (no socket, no Redis presence): ` +
      ghosts.map(g => g.name).join(', '),
    );
  }

  return reachable;
}

/**
 * Score mechanics and return the top `limit` sorted by composite score.
 *
 * Formula (max 100 pts):
 *   score = proximityScore + ratingScore + acceptanceScore + onlineBonus
 *
 *   proximityScore  = exp(-dist / 3) × 40         → smooth decay (≈0.5 at 2km, ≈0.13 at 6km)
 *   ratingScore     = (rating / 5) × 30           → 0–30 pts
 *   acceptanceScore = acceptanceRate × 20         → 0–20 pts (default 0.85 for new mechanics)
 *   onlineBonus     = 10                          → always 10 (already filtered online)
 *
 * Acceptance-rate floor: mechanics with ≥10 offers and an acceptance rate
 * below 10% are dropped. They mostly auto-reject and only burn the user's
 * wait window — keeping them out of the queue is a real UX win, while a
 * minimum-offers gate prevents punishing a mechanic for one bad day.
 */
function _scoreAndRank(mechanics, limit = 20) {
  const ACCEPTANCE_FLOOR_RATE = 0.10;
  const ACCEPTANCE_FLOOR_MIN_OFFERS = 10;

  const scored = mechanics
    .filter(m => m.distance !== null)
    .map(m => {
      const dist = Math.max(m.distance || 0, 0);
      const rating = Math.min(5, Math.max(0, m.ratingAverage || 3.5));

      // Acceptance rate: if mechanic has history use real rate, else default 0.85
      const offered = m.totalOffersReceived || 0;
      const accepted = m.totalOffersAccepted || 0;
      const acceptanceRate = offered > 0 ? Math.min(accepted / offered, 1) : 0.85;

      // Smooth exponential proximity decay — no cliff at the 0.1km boundary.
      const proximityScore  = Math.exp(-dist / 3) * 40;
      const ratingScore     = (rating / 5) * 30;
      const acceptanceScore = acceptanceRate * 20;
      const onlineBonus     = 10;

      const score = proximityScore + ratingScore + acceptanceScore + onlineBonus;

      return { ...m, score, acceptanceRate, _offered: offered };
    })
    .filter(m => !(m._offered >= ACCEPTANCE_FLOOR_MIN_OFFERS && m.acceptanceRate < ACCEPTANCE_FLOOR_RATE))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  console.log(`✅ Ranked ${scored.length} mechanics (top 5):`);
  scored.slice(0, 5).forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.fullName || 'Unknown'} | dist=${m.distance?.toFixed(2)}km | rating=${m.ratingAverage?.toFixed(1)} | accept=${(m.acceptanceRate * 100).toFixed(0)}% | score=${m.score?.toFixed(1)}`);
  });

  return scored;
}

/**
 * Calculate distance between two coordinates (Haversine formula)
 * Used as fallback when $nearSphere is not available
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}

/**
 * Create payment order for a booking
 * POST /api/booking/:id/pay
 */
const createBookingPaymentOrder = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({
    _id: req.params.id,
    userId: req.user.id,
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Booking not found');
  }

  if (booking.paymentStatus === 'PAID') {
    return ApiResponse.badRequest(res, 'Booking already paid');
  }

  const amount = booking.pricing.totalAmount;

  // Create Razorpay order
  const orderResult = await razorpayService.createOrder({
    amount,
    receipt: `booking_${booking._id}_${Date.now()}`,
    notes: {
      bookingId: booking._id.toString(),
      userId: req.user.id.toString(),
      purpose: 'BOOKING_PAYMENT',
    },
  });

  if (!orderResult.success) {
    return ApiResponse.serverError(res, 'Failed to create payment order');
  }

  // Save order ID to booking
  booking.paymentDetails = {
    razorpayOrderId: orderResult.order.id,
    createdAt: new Date(),
  };
  await booking.save();

  ApiResponse.success(res, {
    orderId: orderResult.order.id,
    amount: orderResult.order.amount,
    currency: orderResult.order.currency,
    keyId: razorpayService.getKeyId(),
    bookingId: booking._id,
  }, 'Payment order created');
});

/**
 * Verify booking payment
 * POST /api/booking/:id/verify-payment
 */
const verifyBookingPayment = asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const booking = await Booking.findOne({
    _id: req.params.id,
    userId: req.user.id,
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Booking not found');
  }

  // Idempotency guard — already paid; treat repeat verify as success no-op.
  if (booking.paymentStatus === 'PAID') {
    return ApiResponse.success(res, { booking }, 'Payment already verified');
  }

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return ApiResponse.badRequest(res, 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required');
  }

  // Verify payment signature
  const verification = razorpayService.verifyPayment(
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  );

  if (!verification.success) {
    return ApiResponse.badRequest(res, 'Payment verification failed');
  }

  if (booking.paymentDetails?.razorpayOrderId && booking.paymentDetails.razorpayOrderId !== razorpay_order_id) {
    return ApiResponse.badRequest(res, 'Order mismatch for this booking');
  }

  const paymentInfo = await razorpayService.getPayment(razorpay_payment_id);
  if (!paymentInfo.success || paymentInfo.payment.status !== 'captured') {
    return ApiResponse.badRequest(res, 'Payment not captured');
  }

  if (booking.pricing?.totalAmount && paymentInfo.payment.amount !== booking.pricing.totalAmount) {
    return ApiResponse.badRequest(res, 'Payment amount mismatch');
  }

  const resolvedMethod = paymentInfo.payment.method?.toUpperCase();
  const paymentMethod = resolvedMethod === 'UPI' ? 'UPI'
    : resolvedMethod === 'NETBANKING' ? 'NETBANKING'
    : 'CARD';

  // Atomically transition paymentStatus PENDING -> PAID so concurrent verify
  // attempts (or webhook + verify) cannot both run the earning creation block.
  const updatedBooking = await Booking.findOneAndUpdate(
    { _id: booking._id, paymentStatus: { $ne: 'PAID' } },
    {
      $set: {
        paymentStatus: 'PAID',
        paymentMethod,
        'paymentDetails.razorpayPaymentId': razorpay_payment_id,
        'paymentDetails.razorpaySignature': razorpay_signature,
        'paymentDetails.onlineAmount': booking.pricing?.totalAmount || 0,
        'paymentDetails.paidAt': new Date(),
      },
    },
    { new: true }
  );

  if (!updatedBooking) {
    // Someone else (webhook?) already marked it paid — be idempotent.
    const refreshed = await Booking.findById(booking._id);
    return ApiResponse.success(res, { booking: refreshed }, 'Payment already verified');
  }

  // Continue with the freshly-paid booking.
  Object.assign(booking, updatedBooking.toObject());

  const user = await User.findById(booking.userId);

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
    customerName: user?.name || 'Customer',
    customerPhone: user?.phone || '',
    location: {
      address: booking.location?.address || '',
    },
    paymentMethod,
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
      razorpayOrderId: booking.paymentDetails?.razorpayOrderId || razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      settledAt: new Date(),
    },
    { upsert: true, new: true }
  );

  // Auto-settle any pending debts from mechanic's earnings
  try {
    await cashflowSettlementService.processPaymentWithAutoSettlement(
      booking,
      razorpay_payment_id
    );
  } catch (debtError) {
    console.warn('⚠️ Debt settlement failed (non-blocking):', debtError.message);
  }

  socketService.notifyPaymentReceived(booking.mechanicId?.toString(), {
    bookingId: booking._id.toString(),
    amount: booking.pricing.totalAmount,
  });

  ApiResponse.success(res, {
    booking,
    paymentId: razorpay_payment_id,
  }, 'Payment successful');
});

/**
 * Pay with wallet
 * POST /api/booking/:id/pay-wallet
 */
const payWithWallet = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({
    _id: req.params.id,
    userId: req.user.id,
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Booking not found');
  }

  if (booking.paymentStatus === 'PAID') {
    return ApiResponse.badRequest(res, 'Booking already paid');
  }

  const amount = booking.pricing.totalAmount;

  // Try to debit from wallet
  const debitResult = await walletController.debitForBooking(
    req.user.id,
    amount,
    booking._id.toString()
  );

  if (!debitResult.success) {
    return ApiResponse.badRequest(res, debitResult.message || 'Insufficient wallet balance');
  }

  // Update booking payment status
  booking.paymentStatus = 'PAID';
  booking.paymentMethod = 'WALLET';
  booking.paymentDetails = {
    walletTransactionId: debitResult.transactionId,
    walletAmount: amount,
    paidAt: new Date(),
  };
  await booking.save();

  const user = await User.findById(booking.userId);

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
    customerName: user?.name || 'Customer',
    customerPhone: user?.phone || '',
    location: {
      address: booking.location?.address || '',
    },
    paymentMethod: 'WALLET',
  });

  ApiResponse.success(res, { booking }, 'Payment successful via wallet');
});

/**
 * Generate Razorpay UPI QR (preferred) or payment link (fallback) for job payment.
 * UPI QR opens in customer's GPay / PhonePe / Paytm when scanned.
 * Webhooks: qr_code.credited (UPI QR) or payment_link.paid (link fallback).
 *
 * POST /api/mechanic/job/:id/payment-link
 */
const generateJobPaymentLink = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
    status: { $in: ['IN_PROGRESS', 'COMPLETED', 'ARRIVED'] },
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Active job not found');
  }

  if (booking.paymentStatus === 'PAID') {
    return ApiResponse.badRequest(res, 'Payment already confirmed for this job');
  }

  const amount = Math.round(Number(booking.pricing?.totalAmount || 0) * 100) / 100;
  if (amount < 1) {
    return ApiResponse.badRequest(res, 'Invalid booking amount');
  }

  const customer = await User.findById(booking.userId).select('name phone');

  const desc = `MecFinder — ${booking.serviceSnapshot?.name || 'Roadside Assistance'}`;

  const qrResult = await razorpayService.createUpiQrCode({
    amount,
    bookingId: booking._id.toString(),
    mechanicId: req.mechanic.id.toString(),
    bookingCode: booking.bookingId || booking._id.toString(),
    description: desc,
  });

  if (qrResult.success) {
    booking.paymentDetails = {
      ...booking.paymentDetails,
      razorpayQrCodeId: qrResult.qr.id,
    };
    await booking.save();

    return ApiResponse.success(
      res,
      {
        upiQrImageUrl: qrResult.qr.image_url,
        qrCodeId: qrResult.qr.id,
        amount,
        bookingId: booking._id,
        paymentKind: 'upi_qr',
      },
      'UPI QR ready — customer scans with any UPI app.'
    );
  }

  console.warn('[mechanic/job payment] UPI QR not available, using payment link:', qrResult.error);

  const linkResult = await razorpayService.createPaymentLink({
    amount,
    referenceId: booking.bookingId || booking._id.toString(),
    description: desc,
    customer: {
      name: customer?.name || 'Customer',
      contact: customer?.phone || '+919999999999',
    },
    notes: {
      bookingId: booking._id.toString(),
      mechanicId: req.mechanic.id,
      purpose: 'JOB_PAYMENT',
    },
  });

  if (!linkResult.success) {
    return ApiResponse.serverError(
      res,
      `Payment setup failed (UPI QR: ${qrResult.error}; link: ${linkResult.error})`
    );
  }

  booking.paymentDetails = {
    ...booking.paymentDetails,
    razorpayPaymentLinkId: linkResult.paymentLink.id,
  };
  await booking.save();

  ApiResponse.success(
    res,
    {
      paymentLink: linkResult.paymentLink.short_url,
      paymentLinkId: linkResult.paymentLink.id,
      paymentLinkUpiFirst: !!linkResult.paymentLink.upi_link,
      amount,
      bookingId: booking._id,
      paymentKind: 'payment_link',
      usedFallbackPaymentLink: true,
    },
    'Payment link generated (UPI QR unavailable on this account). Share with customer.'
  );
});

/**
 * Lightweight payment / status read for mechanic polling (UPI payment link flow).
 * GET /api/mechanic/job/:id/payment-status
 */
const getJobPaymentStatus = asyncHandler(async (req, res) => {
  const booking = await Booking.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
  }).select('paymentStatus status bookingId pricing');

  if (!booking) {
    return ApiResponse.notFound(res, 'Job not found');
  }

  ApiResponse.success(res, {
    paymentStatus: booking.paymentStatus,
    status: booking.status,
    bookingCode: booking.bookingId,
    mechanicEarning: booking.pricing?.mechanicEarning ?? 0,
  });
});

module.exports = {
  // User
  createBooking,
  getUserBookings,
  getBookingDetails,
  cancelBooking,
  rateBooking,
  getBookingHistory,
  // Payment
  createBookingPaymentOrder,
  verifyBookingPayment,
  payWithWallet,
  // Mechanic
  getMechanicJobs,
  getCurrentBooking,
  getMechanicBookingHistory,
  acceptJob,
  updateJobStatus,
  confirmPayment,
  rejectJob,
  cancelJobByMechanic,
  generateJobPaymentLink,
  getJobPaymentStatus,
  // Debug
  checkNearbyMechanics,
  // Helpers (for internal use)
  findNearbyMechanics,
};
