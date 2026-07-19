const PlatformSettings = require('../models/PlatformSettings');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

const getSettings = asyncHandler(async (req, res) => {
  const settings = await PlatformSettings.get();
  ApiResponse.success(res, { settings });
});

const updateCashPolicy = asyncHandler(async (req, res) => {
  const { maxConsecutiveCashJobs, maxCashJobsPerDay, blockOnDebtOverdue, debtDueHours } = req.body;
  const updates = {};
  if (maxConsecutiveCashJobs !== undefined) updates['cash.maxConsecutiveCashJobs'] = Math.max(1, Math.min(20, Number(maxConsecutiveCashJobs)));
  if (maxCashJobsPerDay !== undefined) updates['cash.maxCashJobsPerDay'] = Math.max(1, Math.min(50, Number(maxCashJobsPerDay)));
  if (blockOnDebtOverdue !== undefined) updates['cash.blockOnDebtOverdue'] = Boolean(blockOnDebtOverdue);
  if (debtDueHours !== undefined) updates['cash.debtDueHours'] = Math.max(1, Math.min(168, Number(debtDueHours)));

  const settings = await PlatformSettings.findOneAndUpdate({}, { $set: updates }, { new: true, upsert: true });
  ApiResponse.success(res, { settings }, 'Cash policy updated');
});

const updatePayoutPolicy = asyncHandler(async (req, res) => {
  const { autoPayoutEnabled, autoPayoutIntervalHours, minPayoutAmount, maxDailyPayout, tdsPercent, tdsThreshold } = req.body;
  const updates = {};
  if (autoPayoutEnabled !== undefined) updates['payout.autoPayoutEnabled'] = Boolean(autoPayoutEnabled);
  if (autoPayoutIntervalHours !== undefined) updates['payout.autoPayoutIntervalHours'] = Math.max(1, Math.min(168, Number(autoPayoutIntervalHours)));
  if (minPayoutAmount !== undefined) updates['payout.minPayoutAmount'] = Math.max(1, Math.min(100000, Number(minPayoutAmount)));
  if (maxDailyPayout !== undefined) updates['payout.maxDailyPayout'] = Math.max(1000, Number(maxDailyPayout));
  if (tdsPercent !== undefined) updates['payout.tdsPercent'] = Math.max(0, Math.min(30, Number(tdsPercent)));
  if (tdsThreshold !== undefined) updates['payout.tdsThreshold'] = Math.max(0, Number(tdsThreshold));

  const settings = await PlatformSettings.findOneAndUpdate({}, { $set: updates }, { new: true, upsert: true });
  ApiResponse.success(res, { settings }, 'Payout policy updated');
});

const updateCommissionPolicy = asyncHandler(async (req, res) => {
  const { platformFeePercent, gstOnPlatformFeePercent } = req.body;
  const updates = {};
  if (platformFeePercent !== undefined) updates['commission.platformFeePercent'] = Math.max(0, Math.min(50, Number(platformFeePercent)));
  if (gstOnPlatformFeePercent !== undefined) updates['commission.gstOnPlatformFeePercent'] = Math.max(0, Math.min(28, Number(gstOnPlatformFeePercent)));

  const settings = await PlatformSettings.findOneAndUpdate({}, { $set: updates }, { new: true, upsert: true });
  ApiResponse.success(res, { settings }, 'Commission policy updated');
});

module.exports = { getSettings, updateCashPolicy, updatePayoutPolicy, updateCommissionPolicy };
