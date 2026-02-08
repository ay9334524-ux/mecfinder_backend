const express = require('express');
const {
  getAllCategories,
  seedCategories,
  updateCategoryStatus,
  getAllServices,
  getServiceById,
  createService,
  updateService,
  deleteService
} = require('../controller/service.controller');
const { authMiddleware, requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();

// ==================== CATEGORIES ====================
// Public routes
router.get('/categories', getAllCategories);

// Protected routes (ADMIN/SUPER_ADMIN only)
router.post('/categories/seed', authMiddleware, requireAdmin, seedCategories);
router.patch('/categories/:id/status', authMiddleware, requireAdmin, updateCategoryStatus);

// ==================== SERVICES ====================
// Public routes
router.get('/', getAllServices);
router.get('/:id', getServiceById);

// Protected routes (ADMIN/SUPER_ADMIN only)
router.post('/', authMiddleware, requireAdmin, createService);
router.put('/:id', authMiddleware, requireAdmin, updateService);
router.delete('/:id', authMiddleware, requireAdmin, deleteService);

module.exports = router;
