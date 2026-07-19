const Banner = require('../models/Banner');
const ApiResponse = require('../utils/apiResponse');
const { asyncHandler } = require('../middleware/error.middleware');

/**
 * Public: list active banners.
 * GET /api/public/banners?regionId=<id>
 */
const listActiveBanners = asyncHandler(async (req, res) => {
  const { regionId } = req.query;
  const banners = await Banner.findActive({ regionId });
  ApiResponse.success(res, { banners });
});

/* --- Admin endpoints --- */

/**
 * Admin: list all banners.
 * GET /api/admin/banners
 */
const listAllBanners = asyncHandler(async (req, res) => {
  const banners = await Banner.find().sort({ order: 1, createdAt: -1 });
  ApiResponse.success(res, { banners });
});

/**
 * Admin: create a banner.
 * POST /api/admin/banners
 */
const createBanner = asyncHandler(async (req, res) => {
  const {
    title,
    subtitle,
    imageUrl,
    linkUrl,
    ctaLabel,
    order,
    isActive,
    startsAt,
    endsAt,
    regionId,
  } = req.body;

  if (!title || !imageUrl) {
    return ApiResponse.error(res, 'title and imageUrl are required', 400);
  }

  const banner = await Banner.create({
    title,
    subtitle,
    imageUrl,
    linkUrl,
    ctaLabel,
    order: typeof order === 'number' ? order : 0,
    isActive: isActive !== false,
    startsAt: startsAt || undefined,
    endsAt: endsAt || undefined,
    regionId: regionId || null,
  });
  ApiResponse.success(res, { banner }, 'Banner created', 201);
});

/**
 * Admin: update a banner.
 * PUT /api/admin/banners/:id
 */
const updateBanner = asyncHandler(async (req, res) => {
  const updates = { ...req.body };
  // Disallow direct timestamp overrides
  delete updates._id;
  delete updates.createdAt;
  delete updates.updatedAt;

  const banner = await Banner.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  });
  if (!banner) {
    return ApiResponse.error(res, 'Banner not found', 404);
  }
  ApiResponse.success(res, { banner }, 'Banner updated');
});

/**
 * Admin: delete a banner.
 * DELETE /api/admin/banners/:id
 */
const deleteBanner = asyncHandler(async (req, res) => {
  const banner = await Banner.findByIdAndDelete(req.params.id);
  if (!banner) {
    return ApiResponse.error(res, 'Banner not found', 404);
  }
  ApiResponse.success(res, null, 'Banner deleted');
});

module.exports = {
  listActiveBanners,
  listAllBanners,
  createBanner,
  updateBanner,
  deleteBanner,
};
