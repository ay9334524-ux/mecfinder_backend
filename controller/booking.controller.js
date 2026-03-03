const Booking = require('../models/Booking');
const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const Service = require('../models/Service');
const RegionPricing = require('../models/RegionPricing');
const redisService = require('../services/redis.service');
const socketService = require('../services/socket.service');
const bookingQueueService = require('../services/bookingQueue.service');
const razorpayService = require('../services/razorpay.service');
const firebaseService = require('../services/firebase.service');
const notificationService = require('../services/notification.service');
const bookingEventEmitter = require('../services/bookingEventEmitter.service');
const walletController = require('./wallet.controller');
const notificationController = require('./notification.controller');
const earningsController = require('./earnings.controller');
const referralController = require('./referral.controller');
const rewardsController = require('./rewards.controller');
const ApiResponse = require('../utils/apiResponse');
const RedisLock = require('../utils/redisLock');
const { asyncHandler } = require('../middleware/error.middleware');

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
      idempotencyKey, // Client can send a unique key to prevent duplicates on retry
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

    // Get pricing (use default or region-based)
    let pricing = await RegionPricing.findOne({ serviceId });
    if (!pricing) {
      pricing = {
        basePrice: service.basePrice,
        gstPercent: 18,
        platformFeePercent: 25,
        travelCharge: 88,
      };
    }

    // Calculate total
    const basePrice = pricing.basePrice;
    const gstAmount = (basePrice * pricing.gstPercent) / 100;
    const platformFeeAmount = (basePrice * pricing.platformFeePercent) / 100;
    const travelCharge = pricing.travelCharge;
    let discount = 0;

    const totalAmount = basePrice + gstAmount + travelCharge - discount;
    const mechanicEarning = basePrice - platformFeeAmount;
    const companyEarning = platformFeeAmount + gstAmount;

    // Generate 4-digit verification OTP
    const verificationOtp = Math.floor(1000 + Math.random() * 9000).toString();

    // Create booking
    const booking = await Booking.create({
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
        gstPercent: pricing.gstPercent,
        gstAmount,
        platformFeePercent: pricing.platformFeePercent,
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

    // Send booking confirmation notification
    try {
      await notificationService.sendBookingConfirmationNotification(userId, booking);
    } catch (error) {
      console.error('Error sending booking confirmation notification:', error);
    }

    // ═══════════════════════════════════════════════════════════
    // 📍 FIND NEARBY MECHANICS (Production GeoJSON + Haversine fallback)
    // First try 5km, then expand to 10km if no mechanics found
    // ═══════════════════════════════════════════════════════════
    console.log(`📍 User booking location: lat=${location.latitude}, lng=${location.longitude}`);
    console.log(`🚗 Vehicle type requested: ${vehicleDetails?.type || 'CAR'}`);
    
    let nearbyMechanics = await findNearbyMechanics(
      location.latitude, 
      location.longitude, 
      vehicleDetails?.type || 'CAR',
      5 // 5 km radius first
    );
    
    let searchRadius = 5;
    
    // If no mechanics in 5km, expand to 10km
    if (nearbyMechanics.length === 0) {
      console.log('🔄 No mechanics in 5km, expanding to 10km...');
      nearbyMechanics = await findNearbyMechanics(
        location.latitude, 
        location.longitude, 
        vehicleDetails?.type || 'CAR',
        10 // 10 km radius
      );
      searchRadius = 10;
    }

    console.log(`✅ Total nearby mechanics found: ${nearbyMechanics.length}`);
    nearbyMechanics.forEach(m => {
      console.log(`   - ${m.fullName} (${m._id}): ${m.distance?.toFixed(2)}km, fcmToken: ${m.fcmToken ? 'YES' : 'NO'}`);
    });

    // Store dispatch metadata on booking
    booking.dispatchInfo = {
      totalMechanicsNotified: nearbyMechanics.length,
      searchRadiusKm: searchRadius,
    };
    await booking.save();

    if (nearbyMechanics.length > 0) {
      // Start round-robin queue - sends to one mechanic at a time
      // with 15 second timeout before moving to next
      await bookingQueueService.startQueue(booking, nearbyMechanics);
    } else {
      // No mechanics available
      console.log('❌ No mechanics available after all searches');
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
  const { page = 1, limit = 10, status } = req.query;
  const skip = (page - 1) * limit;

  const filter = { userId: req.user.id };
  if (status) filter.status = status;

  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('mechanicId', 'fullName phone ratingAverage profilePhoto'),
    Booking.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, bookings, {
    page: parseInt(page),
    limit: parseInt(limit),
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

  await booking.updateStatus('CANCELLED', {
    reason,
    cancelledBy: 'USER',
  });

  // Emit booking cancelled event
  bookingEventEmitter.emitBookingStatusChange(booking, booking.status, booking.mechanicId);

  // Process refund if payment was made
  if (booking.paymentStatus === 'PAID' && booking.paymentDetails?.walletAmount > 0) {
    await walletController.creditRefund(
      req.user.id,
      booking.paymentDetails.walletAmount,
      booking._id.toString(),
      'Booking cancellation refund'
    );
  }

  // Notify mechanic if assigned
  if (booking.mechanicId) {
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

  // If booking was still searching, cleanup the queue
  if (['PENDING', 'SEARCHING'].includes(booking.status)) {
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
  const { page = 1, limit = 10, status } = req.query;
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
      .limit(parseInt(limit))
      .populate('userId', 'name phone'),
    Booking.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, jobs, {
    page: parseInt(page),
    limit: parseInt(limit),
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
    status: { $in: ['ASSIGNED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'] },
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
  const { status, page = 1, limit = 20 } = req.query;
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
      .limit(parseInt(limit))
      .populate('userId', 'name phone profilePhoto'),
    Booking.countDocuments(filter),
  ]);

  ApiResponse.success(res, {
    bookings,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

/**
 * Accept job (mechanic)
 * POST /api/mechanic/job/:id/accept
 * Uses atomic update to prevent race condition when multiple mechanics try to accept
 */
const acceptJob = asyncHandler(async (req, res) => {
  // Atomic update - only one mechanic can accept at a time
  const booking = await Booking.findOneAndUpdate(
    {
      _id: req.params.id,
      mechanicId: req.mechanic.id,
      status: 'ASSIGNED', // Only accept if still in ASSIGNED status
    },
    {
      $set: {
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      }
    },
    { new: true }
  );

  if (!booking) {
    return ApiResponse.notFound(res, 'Job not found or already processed by another mechanic');
  }

  // Add status history
  booking.statusHistory.push({
    status: 'ACCEPTED',
    timestamp: new Date(),
    notes: 'Job accepted by mechanic',
  });
  await booking.save();

  // Emit booking accepted event
  const mechanic = await Mechanic.findById(req.mechanic.id);
  bookingEventEmitter.emitBookingStatusChange(booking, 'ASSIGNED', mechanic);

  // Notify user
  await notificationController.sendBookingNotification(
    booking.userId,
    'Mechanic Assigned',
    'A mechanic has accepted your booking and will arrive soon',
    booking._id
  );

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

  console.log('📋 Current booking status:', booking.status);
  console.log('📋 Requested new status:', status);
  console.log('📋 OTP provided:', otp);
  console.log('📋 Booking verificationOtp:', booking.verificationOtp);

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
    // Convert both to string for comparison (handles number vs string)
    const providedOtp = String(otp).trim();
    const storedOtp = String(booking.verificationOtp).trim();
    console.log('📋 OTP comparison:', { providedOtp, storedOtp, match: providedOtp === storedOtp });
    
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
  
  console.log('💰 confirmPayment called');
  console.log('💰 Booking ID:', req.params.id);
  console.log('💰 Mechanic ID:', req.mechanic?.id);
  console.log('💰 Payment Method:', paymentMethod);

  // Allow confirm payment for IN_PROGRESS or COMPLETED status
  const booking = await Booking.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
    status: { $in: ['IN_PROGRESS', 'COMPLETED'] },
  });

  console.log('💰 Booking found:', booking ? 'YES' : 'NO');
  if (booking) {
    console.log('💰 Booking status:', booking.status);
    console.log('💰 Booking paymentStatus:', booking.paymentStatus);
  }

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

  // Update payment details
  booking.paymentStatus = 'PAID';
  booking.paymentMethod = paymentMethod || 'CASH';
  booking.paymentDetails = {
    ...booking.paymentDetails,
    collectedByMechanic: true,
    paymentMethod,
    transactionId: transactionId || null,
    collectedAt: new Date(),
  };
  
  try {
    await booking.save();
  } catch (saveError) {
    console.error('❌ Booking save error:', saveError);
    return ApiResponse.error(res, 'Failed to save booking: ' + saveError.message, 422);
  }

  // Create earning for mechanic (with null checks)
  try {
    const user = await User.findById(booking.userId);
    const grossAmount = (booking.pricing?.mechanicEarning || 0) + (booking.pricing?.platformFeeAmount || 0);
    
    await earningsController.createEarning({
      bookingId: booking._id,
      bookingCode: booking.bookingId,
      mechanicId: booking.mechanicId,
      grossAmount: grossAmount,
      platformFeePercent: booking.pricing?.platformFeePercent || 10,
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
 * Reject job (mechanic)
 * POST /api/mechanic/job/:id/reject
 */
const rejectJob = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const booking = await Booking.findOne({
    _id: req.params.id,
    mechanicId: req.mechanic.id,
    status: 'ASSIGNED',
  });

  if (!booking) {
    return ApiResponse.notFound(res, 'Job not found or already processed');
  }

  // Remove assignment and search for another mechanic
  booking.mechanicId = null;
  booking.status = 'SEARCHING';
  booking.searchStartedAt = new Date();
  await booking.save();

  // TODO: Find another mechanic

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

  // Send push notification to user
  if (booking.userId?.fcmToken) {
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
  const { page = 1, limit = 10 } = req.query;
  const skip = (page - 1) * limit;

  const [bookings, total] = await Promise.all([
    Booking.find({
      userId: req.user.id,
      status: { $in: ['COMPLETED', 'CANCELLED'] },
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .populate('mechanicId', 'fullName ratingAverage profilePhoto'),
    Booking.countDocuments({
      userId: req.user.id,
      status: { $in: ['COMPLETED', 'CANCELLED'] },
    }),
  ]);

  ApiResponse.paginated(res, bookings, {
    page: parseInt(page),
    limit: parseInt(limit),
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
 * Find nearby mechanics using MongoDB $nearSphere (production-grade)
 * 
 * Strategy:
 * 1. Try GeoJSON $nearSphere query (requires 2dsphere index + valid coordinates)
 * 2. Fallback to Haversine calculation if GeoJSON query returns 0 (mechanics on legacy schema)
 * 
 * Filters: ACTIVE, online, not busy, no current booking, matching vehicle type
 * Returns: Sorted by distance (nearest first), max 20 mechanics
 */
async function findNearbyMechanics(latitude, longitude, vehicleType, radiusKm = 5) {
  try {
    console.log(`🔍 Finding mechanics: lat=${latitude}, lng=${longitude}, vehicle=${vehicleType}, radius=${radiusKm}km`);
    
    const radiusMeters = radiusKm * 1000;

    // ═══════════════════════════════════════════════════════════
    // PRIMARY: MongoDB $nearSphere with 2dsphere index
    // This is O(log n) with the index vs O(n) with JS Haversine
    // ═══════════════════════════════════════════════════════════
    let mechanics = [];
    
    try {
      mechanics = await Mechanic.find({
        status: 'ACTIVE',
        isOnline: true,
        isBusy: false,
        currentBookingId: null, // Not assigned to any active booking
        vehicleTypes: vehicleType,
        location: {
          $nearSphere: {
            $geometry: {
              type: 'Point',
              coordinates: [longitude, latitude], // GeoJSON: [lng, lat]
            },
            $maxDistance: radiusMeters, // meters
          },
        },
      })
        .select('_id fullName phone profilePhoto ratingAverage location lastLocation fcmToken vehicleTypes address')
        .limit(20);

      console.log(`📋 [GeoJSON] Found ${mechanics.length} mechanics within ${radiusKm}km for ${vehicleType}`);
    } catch (geoError) {
      console.warn(`⚠️ GeoJSON $nearSphere query failed (index may not exist yet): ${geoError.message}`);
      mechanics = [];
    }

    // If GeoJSON found no mechanics with vehicle type, try without vehicle filter
    if (mechanics.length === 0) {
      try {
        mechanics = await Mechanic.find({
          status: 'ACTIVE',
          isOnline: true,
          isBusy: false,
          currentBookingId: null,
          location: {
            $nearSphere: {
              $geometry: {
                type: 'Point',
                coordinates: [longitude, latitude],
              },
              $maxDistance: radiusMeters,
            },
          },
        })
          .select('_id fullName phone profilePhoto ratingAverage location lastLocation fcmToken vehicleTypes address')
          .limit(20);

        console.log(`📋 [GeoJSON] Found ${mechanics.length} mechanics (any vehicle type) within ${radiusKm}km`);
      } catch (geoError) {
        console.warn(`⚠️ GeoJSON fallback also failed: ${geoError.message}`);
        mechanics = [];
      }
    }

    // ═══════════════════════════════════════════════════════════
    // FALLBACK: Haversine distance calculation (for mechanics still on legacy schema)
    // This runs ONLY if $nearSphere returned 0 results
    // ═══════════════════════════════════════════════════════════
    if (mechanics.length === 0) {
      console.log(`🔄 GeoJSON returned 0 results, trying Haversine fallback...`);
      
      let legacyMechanics = await Mechanic.find({
        status: 'ACTIVE',
        isOnline: true,
        isBusy: false,
        currentBookingId: null,
        vehicleTypes: vehicleType,
        'lastLocation.lat': { $exists: true, $ne: null },
        'lastLocation.lng': { $exists: true, $ne: null },
      })
        .select('_id fullName phone profilePhoto ratingAverage lastLocation fcmToken vehicleTypes address')
        .limit(50);

      if (legacyMechanics.length === 0) {
        // Try without vehicle type filter
        legacyMechanics = await Mechanic.find({
          status: 'ACTIVE',
          isOnline: true,
          isBusy: false,
          currentBookingId: null,
          'lastLocation.lat': { $exists: true, $ne: null },
          'lastLocation.lng': { $exists: true, $ne: null },
        })
          .select('_id fullName phone profilePhoto ratingAverage lastLocation fcmToken vehicleTypes address')
          .limit(50);
      }

      console.log(`📋 [Haversine] Found ${legacyMechanics.length} online legacy mechanics`);

      const mechanicsWithDistance = legacyMechanics
        .map(m => {
          const dist = calculateDistance(
            latitude, longitude,
            m.lastLocation?.lat, m.lastLocation?.lng
          );
          return { ...m.toObject(), distance: dist };
        })
        .filter(m => m.distance !== null && m.distance <= radiusKm)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 20);

      console.log(`✅ [Haversine] ${mechanicsWithDistance.length} mechanics within ${radiusKm}km`);
      mechanicsWithDistance.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.fullName}: ${m.distance?.toFixed(2)}km`);
      });

      return mechanicsWithDistance;
    }

    // Calculate distances for GeoJSON results (for display/sorting info)
    const result = mechanics.map(m => {
      const mLat = m.location?.coordinates?.[1] || m.lastLocation?.lat;
      const mLng = m.location?.coordinates?.[0] || m.lastLocation?.lng;
      const dist = calculateDistance(latitude, longitude, mLat, mLng);
      return {
        ...m.toObject(),
        distance: dist,
      };
    });

    console.log(`✅ ${result.length} mechanics within ${radiusKm}km radius:`);
    result.forEach((m, i) => {
      console.log(`  ${i + 1}. ${m.fullName}: ${m.distance?.toFixed(2)}km`);
    });

    return result;
  } catch (error) {
    console.error('❌ Error finding nearby mechanics:', error);
    return [];
  }
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

  if (booking.paymentStatus === 'PAID') {
    return ApiResponse.badRequest(res, 'Booking already paid');
  }

  // Verify payment signature
  const verification = razorpayService.verifyPayment({
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
  });

  if (!verification.success) {
    return ApiResponse.badRequest(res, 'Payment verification failed');
  }

  // Update booking payment status
  booking.paymentStatus = 'PAID';
  booking.paymentDetails = {
    ...booking.paymentDetails,
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature,
    paidAt: new Date(),
  };
  await booking.save();

  // Notify mechanic
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
    paidAt: new Date(),
  };
  await booking.save();

  ApiResponse.success(res, { booking }, 'Payment successful via wallet');
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
  // Debug
  checkNearbyMechanics,
  // Helpers (for internal use)
  findNearbyMechanics,
};
