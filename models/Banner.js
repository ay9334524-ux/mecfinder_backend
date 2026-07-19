const mongoose = require('mongoose');

/**
 * Promotional banners shown in the customer app's homepage carousel.
 * Managed via the admin panel.
 */
const bannerSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, trim: true },
    imageUrl: { type: String, required: true, trim: true },
    // Optional destination — can be an internal app deeplink (e.g.
    // `mecfinder://offers`) or an external https URL.
    linkUrl: { type: String, trim: true },
    // Optional CTA label rendered on the banner
    ctaLabel: { type: String, trim: true },
    // Display order — smaller numbers come first
    order: { type: Number, default: 0, index: true },
    isActive: { type: Boolean, default: true, index: true },
    // Optional time window
    startsAt: { type: Date },
    endsAt: { type: Date },
    // Optional region scoping
    regionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Region',
      default: null,
    },
  },
  { timestamps: true },
);

bannerSchema.index({ isActive: 1, order: 1 });

bannerSchema.statics.findActive = function ({ regionId } = {}) {
  const now = new Date();
  const query = {
    isActive: true,
    $and: [
      { $or: [{ startsAt: { $exists: false } }, { startsAt: null }, { startsAt: { $lte: now } }] },
      { $or: [{ endsAt: { $exists: false } }, { endsAt: null }, { endsAt: { $gte: now } }] },
    ],
  };
  if (regionId) {
    query.$and.push({ $or: [{ regionId: null }, { regionId }] });
  }
  return this.find(query).sort({ order: 1, createdAt: -1 });
};

module.exports = mongoose.model('Banner', bannerSchema);
