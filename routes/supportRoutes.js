const express = require('express');
const {
  getAllQueries,
  getQueryById,
  createQuery,
  updateQueryStatus,
  assignQuery,
  getQueryStats
} = require('../controller/support.controller');
const { authMiddleware, requireSupport, requireAdmin } = require('../middleware/auth.middleware');

const router = express.Router();

// Protected routes
router.get('/', authMiddleware, requireSupport, getAllQueries);
router.get('/stats', authMiddleware, requireSupport, getQueryStats);
router.get('/:id', authMiddleware, requireSupport, getQueryById);

// Create query (for testing - normally from user app)
router.post('/', createQuery);

// Update query status (Support can update assigned queries)
router.patch('/:id/status', authMiddleware, requireSupport, updateQueryStatus);

// Assign query (ADMIN/SUPER_ADMIN only)
router.patch('/:id/assign', authMiddleware, requireAdmin, assignQuery);

module.exports = router;
