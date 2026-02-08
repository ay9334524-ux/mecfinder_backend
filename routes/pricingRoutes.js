const express = require('express');
const {
  getAllPricing,
  getPricingByRegion,
  getPricingByService,
  getPricingById,
  upsertPricing,
  updatePricing,
  deletePricing,
  calculatePricing
} = require('../controller/pricing.controller');
const { authMiddleware, requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();

// Public routes (for app)
router.get('/', getAllPricing);
router.get('/region/:regionId', getPricingByRegion);
router.get('/service/:serviceId', getPricingByService);
router.get('/:id', getPricingById);
router.post('/calculate', calculatePricing);

// Protected routes (ADMIN/SUPER_ADMIN only)
router.post('/', authMiddleware, requireAdmin, upsertPricing);
router.put('/:id', authMiddleware, requireAdmin, updatePricing);
router.delete('/:id', authMiddleware, requireAdmin, deletePricing);

module.exports = router;
