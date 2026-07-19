const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * GET /admin/wallet/logs
 */
const listWalletLogs = asyncHandler(async (req, res) => {
  const { category, mechanicId, page = 1, limit = 50 } = req.query;
  const filter = {};
  if (category) filter.category = category;
  if (mechanicId && mongoose.Types.ObjectId.isValid(mechanicId)) {
    filter.mechanicId = new mongoose.Types.ObjectId(mechanicId);
  }

  const p = parseInt(page, 10);
  const l = Math.min(parseInt(limit, 10) || 50, 200);
  const skip = (p - 1) * l;

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(l),
    AuditLog.countDocuments(filter),
  ]);

  ApiResponse.success(res, {
    logs,
    pagination: {
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l) || 1,
      totalItems: total,
    },
  });
});

module.exports = { listWalletLogs };
