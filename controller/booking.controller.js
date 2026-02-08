const Booking = require('../models/Booking');
const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const Service = require('../models/Service');
const RegionPricing = require('../models/RegionPricing');
const redisService = require('../services/redis.service');
const socketService = require('../services/socket.service');
const bookingQueueService = require('../services/bookingQueue.service');
const razorpayService = require('../services/razorpay.service');
const walletController = require('./wallet.controller');
const notificationController = require('./notification.controller');
const earningsController = require('./earnings.controller');
const referralController = require('./referral.controller');
const rewardsController = require('./rewards.controller');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Create a new booking
 * POST /api/booking
 */
const createBooking = asyncHandler(async (req, res) => {
  const { 
    serviceId, 
    location, 
    vehicleDetails, 
    scheduledAt, 
    notes,
    paymentMethod,
    promoCode,
  } = req.body;

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

  // TODO: Apply promo code discount

  const totalAmount = basePrice + gstAmount + travelCharge - discount;
  const mechanicEarning = basePrice - platformFeeAmount;
  const companyEarning = platformFeeAmount + gstAmount;

  // Generate 4-digit verification OTP
  const verificationOtp = Math.floor(1000 + Math.random() * 9000).toString();

  // Create booking
  const booking = await Booking.create({
    userId: req.user.id,
    serviceId,
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

  // Find nearby mechanics and start round-robin queue
  const nearbyMechanics = await findNearbyMechanics(
    location.latitude, 
    location.longitude, 
    vehicleDetails?.type || 'CAR',
    10 // 10 km radius
  );

  if (nearbyMechanics.length > 0) {
    // Start round-robin queue - sends to one mechanic at a time
    // with 10 second timeout before moving to next
    await bookingQueueService.startQueue(booking, nearbyMechanics);
  } else {
    // No mechanics available
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

  const cancellableStatuses = ['PENDING', 'SEARCHING', 'ASSIGNED', 'ACCEPTED'];
  if (!cancellableStatuses.includes(booking.status)) {
    return ApiResponse.badRequest(res, 'Booking cannot be cancelled at this stage');
  }

  await booking.updateStatus('CANCELLED', {
    reason,
    cancelledBy: 'USER',
  });

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
    await notificationController.sendJobNotification(
      booking.mechanicId,
      'Booking Cancelled',
      'Customer has cancelled the booking',
      booking._id,
      'NORMAL'
    );
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
    return ApiResponse.notFound(res, 'Job not found or not in progress');
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

  // Emit to user to show rating prompt
  socketService.emitToUser(booking.userId.toString(), 'booking:payment_confirmed', {
    bookingId: booking._id,
    amount: booking.pricing?.totalAmount || 0,
    showRatingPrompt: true,
  });

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
 * Find nearby mechanics helper
 */
async function findNearbyMechanics(latitude, longitude, vehicleType, radiusKm = 10) {
  try {
    // First try Redis geospatial (faster)
    if (redisService.isConnected) {
      const nearbyFromRedis = await redisService.getNearbyMechanics(
        latitude,
        longitude,
        radiusKm * 1000 // Convert to meters
      );
      
      if (nearbyFromRedis && nearbyFromRedis.length > 0) {
        const mechanicIds = nearbyFromRedis.map(m => m.id);
        const mechanics = await Mechanic.find({
          _id: { $in: mechanicIds },
          status: 'ACTIVE',
          isOnline: true,
          'vehicleTypes': vehicleType,
        }).select('_id fullName phone profilePhoto ratingAverage');
        
        // Attach distances
        return mechanics.map(m => {
          const redisData = nearbyFromRedis.find(r => r.id === m._id.toString());
          return {
            ...m.toObject(),
            distance: redisData?.distance ? redisData.distance / 1000 : null, // km
          };
        });
      }
    }

    // Fallback to simple query - get all online mechanics and filter by distance
    const mechanics = await Mechanic.find({
      status: 'ACTIVE',
      isOnline: true,
      vehicleTypes: vehicleType,
      'lastLocation.lat': { $exists: true },
      'lastLocation.lng': { $exists: true },
    })
      .select('_id fullName phone profilePhoto ratingAverage lastLocation')
      .limit(50);

    // Calculate distances and filter
    const mechanicsWithDistance = mechanics
      .map(m => {
        const dist = calculateDistance(
          latitude, longitude,
          m.lastLocation?.lat, m.lastLocation?.lng
        );
        return {
          ...m.toObject(),
          distance: dist,
        };
      })
      .filter(m => m.distance !== null && m.distance <= radiusKm)
      .sort((a, b) => a.distance - b.distance);
      // No limit - include all nearby mechanics for round-robin

    return mechanicsWithDistance;
  } catch (error) {
    console.error('Error finding nearby mechanics:', error);
    
    // Ultimate fallback - just get online mechanics
    return Mechanic.find({
      status: 'ACTIVE',
      isOnline: true,
      'vehicleTypes': vehicleType,
    })
      .select('_id fullName phone profilePhoto ratingAverage')
      .limit(10);
  }
}

/**
 * Calculate distance between two coordinates (Haversine formula)
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
  acceptJob,
  updateJobStatus,
  confirmPayment,
  rejectJob,
  // Helpers (for internal use)
  findNearbyMechanics,
};
