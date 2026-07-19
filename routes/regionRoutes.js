const express = require('express');
const {
  getAllRegions,
  getRegionById,
  createRegion,
  updateRegion,
  deleteRegion
} = require('../controller/region.controller');
const { authMiddleware, requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();

// Public routes
router.get('/', getAllRegions);
router.get('/:id', getRegionById);

// Protected routes (ADMIN/SUPER_ADMIN only)
router.post('/', authMiddleware, requireAdmin, createRegion);
router.put('/:id', authMiddleware, requireAdmin, updateRegion);
router.delete('/:id', authMiddleware, requireAdmin, deleteRegion);

module.exports = router;
