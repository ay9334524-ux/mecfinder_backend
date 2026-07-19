const mongoose = require('mongoose');
const MechanicPayout = require('../models/MechanicPayout');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');
const { fulfillMechanicPayout } = require('../services/payoutExecution.service');

/**
 * GET /admin/payouts
 * Query: status=REQUESTED | ALL | PROCESSING …
 */
const listPayouts = asyncHandler(async (req, res) => {
  const { status = 'REQUESTED', page = 1, limit = 30 } = req.query;
  const filter = {};

  if (status === 'ALL') {
    filter.status = { $nin: ['CANCELLED'] };
  } else if (status === 'QUEUE') {
    filter.status = { $in: ['REQUESTED', 'ON_HOLD'] };
  } else {
    filter.status = status;
  }

  const p = parseInt(page, 10);
  const l = Math.min(parseInt(limit, 10) || 30, 100);
  const skip = (p - 1) * l;

  const [rows, total] = await Promise.all([
    MechanicPayout.find(filter)
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(l)
      .populate('mechanicId', 'fullName phone bankDetails profilePhoto'),
    MechanicPayout.countDocuments(filter),
  ]);

  ApiResponse.success(res, {
    payouts: rows,
    pagination: {
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l) || 1,
      totalItems: total,
    },
  });
});

/**
 * POST /admin/payouts/:id/approve
 * Deduct wallet + optional Razorpay transfer (same engine as 24h auto-queue).
 */
const approvePayout = asyncHandler(async (req, res) => {
  const { adminNotes } = req.body || {};
  const payout = await MechanicPayout.findById(req.params.id);

  if (!payout || !['REQUESTED', 'ON_HOLD'].includes(payout.status)) {
    return ApiResponse.badRequest(res, 'Payout not in approval queue.');
  }

  if (adminNotes) {
    payout.adminNotes = String(adminNotes).slice(0, 500);
    await payout.save();
  }

  const result = await fulfillMechanicPayout(req.params.id, {
    adminId: req.admin?.id?.toString(),
    source: 'ADMIN',
  });

  if (result.skipped) {
    return ApiResponse.badRequest(
      res,
      'Payout could not be approved (already processed, debt on account, or balance mismatch).',
    );
  }

  if (!result.ok) {
    return ApiResponse.serverError(
      res,
      result.error || 'Bank transfer failed — wallet was not debited',
    );
  }

  ApiResponse.success(
    res,
    { payout: result.payout, razorpayStatus: result.razorpayStatus },
    'Payout approved; wallet debited.',
  );
});

/**
 * POST /admin/payouts/:id/reject
 */
const rejectPayout = asyncHandler(async (req, res) => {
  const { reason } = req.body || {};
  const payout = await MechanicPayout.findById(req.params.id);
  if (!payout || !['REQUESTED', 'ON_HOLD'].includes(payout.status)) {
    return ApiResponse.badRequest(res, 'Payout not pending.');
  }
  payout.status = 'CANCELLED';
  payout.adminNotes = (reason || 'Rejected by admin').slice(0, 500);
  payout.processedAt = new Date();
  payout.processedBy = req.admin?.id ? new mongoose.Types.ObjectId(req.admin.id) : undefined;
  await payout.save();

  try {
    const { cancelScheduledPayout } = require('../services/payoutQueue.service');
    await cancelScheduledPayout(req.params.id);
  } catch (_) {}

  const AuditLog = require('../models/AuditLog');
  await AuditLog.create({
    category: 'PAYOUT',
    action: 'PAYOUT_REJECTED',
    mechanicId: payout.mechanicId,
    adminId: req.admin?.id,
    amount: payout.amount,
    status: 'CANCELLED',
    message: payout.adminNotes,
  }).catch(() => {});

  ApiResponse.success(res, { payout }, 'Payout request rejected.');
});

module.exports = {
  listPayouts,
  approvePayout,
  rejectPayout,
};
