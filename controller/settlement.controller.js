const CashSettlement = require('../models/CashSettlement');
const CompanyLedger = require('../models/CompanyLedger');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');
const { clampLimit, clampPage } = require('../utils/pagination');

/**
 * Company ledger summary (Admin)
 * GET /api/admin/ledger/summary
 */
const getCompanyLedgerSummary = asyncHandler(async (req, res) => {
  const [settled, due] = await Promise.all([
    CompanyLedger.aggregate([
      { $match: { status: 'SETTLED' } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          totalPlatformFee: { $sum: '$platformFeeAmount' },
          totalGst: { $sum: '$gstAmount' },
          count: { $sum: 1 },
        },
      },
    ]),
    CompanyLedger.aggregate([
      { $match: { status: 'DUE' } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          totalPlatformFee: { $sum: '$platformFeeAmount' },
          totalGst: { $sum: '$gstAmount' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  const settledData = settled[0] || {
    totalAmount: 0,
    totalPlatformFee: 0,
    totalGst: 0,
    count: 0,
  };

  const dueData = due[0] || {
    totalAmount: 0,
    totalPlatformFee: 0,
    totalGst: 0,
    count: 0,
  };

  ApiResponse.success(res, {
    settled: settledData,
    due: dueData,
    netTotal: settledData.totalAmount + dueData.totalAmount,
  });
});

/**
 * Company ledger entries (Admin)
 * GET /api/admin/ledger
 */
const getCompanyLedgerEntries = asyncHandler(async (req, res) => {
  const { status, paymentMethod } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 20 });
  const skip = (page - 1) * limit;

  const filter = {};
  if (status) filter.status = status;
  if (paymentMethod) filter.paymentMethod = paymentMethod;

  const [entries, total] = await Promise.all([
    CompanyLedger.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('bookingId', 'bookingId pricing.totalAmount paymentStatus paymentMethod')
      .populate('mechanicId', 'fullName phone')
      .populate('userId', 'name phone'),
    CompanyLedger.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, entries, {
    page,
    limit,
    total,
  });
});

/**
 * List cash/UPI settlements (Admin)
 * GET /api/admin/settlements
 */
const getSettlements = asyncHandler(async (req, res) => {
  const { status = 'DUE' } = req.query;
  const page = clampPage(req.query.page);
  const limit = clampLimit(req.query.limit, { def: 20 });
  const skip = (page - 1) * limit;

  const filter = status ? { status } : {};

  const [settlements, total] = await Promise.all([
    CashSettlement.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    CashSettlement.countDocuments(filter),
  ]);

  ApiResponse.paginated(res, settlements, {
    page,
    limit,
    total,
  });
});

/**
 * Mark settlement as paid (Admin)
 * POST /api/admin/settlements/:id/mark-paid
 */
const markSettlementPaid = asyncHandler(async (req, res) => {
  const { adminNotes } = req.body;

  const settlement = await CashSettlement.findById(req.params.id);
  if (!settlement) {
    return ApiResponse.notFound(res, 'Settlement not found');
  }

  if (settlement.status === 'SETTLED') {
    return ApiResponse.badRequest(res, 'Settlement already settled');
  }

  settlement.status = 'SETTLED';
  settlement.settledAt = new Date();
  settlement.settledBy = req.admin?.id;
  settlement.adminNotes = adminNotes || settlement.adminNotes;
  await settlement.save();

  await CompanyLedger.findOneAndUpdate(
    { bookingId: settlement.bookingId },
    { status: 'SETTLED', settledAt: new Date() }
  );

  ApiResponse.success(res, { settlement }, 'Settlement marked as paid');
});

module.exports = {
  getCompanyLedgerSummary,
  getCompanyLedgerEntries,
  getSettlements,
  markSettlementPaid,
};
