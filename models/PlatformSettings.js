const mongoose = require('mongoose');

const platformSettingsSchema = new mongoose.Schema({
  // Cash policy
  cash: {
    maxConsecutiveCashJobs: { type: Number, default: 3 },
    maxCashJobsPerDay: { type: Number, default: 5 },
    blockOnDebtOverdue: { type: Boolean, default: true },
    debtDueHours: { type: Number, default: 24 },
  },
  // Payout policy
  payout: {
    autoPayoutEnabled: { type: Boolean, default: true },
    autoPayoutIntervalHours: { type: Number, default: 24 },
    minPayoutAmount: { type: Number, default: 200 },
    maxDailyPayout: { type: Number, default: 50000 },
    tdsPercent: { type: Number, default: 1 },
    tdsThreshold: { type: Number, default: 10000 },
  },
  // Commission
  commission: {
    platformFeePercent: { type: Number, default: 25 },
    gstOnPlatformFeePercent: { type: Number, default: 18 },
  },
  // QR settings
  qr: {
    enabled: { type: Boolean, default: true },
    expiryMinutes: { type: Number, default: 30 },
  },
}, { timestamps: true });

platformSettingsSchema.statics.get = async function() {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

platformSettingsSchema.statics.update = async function(updates) {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create(updates);
  } else {
    Object.assign(settings, updates);
    await settings.save();
  }
  return settings;
};

module.exports = mongoose.model('PlatformSettings', platformSettingsSchema);
