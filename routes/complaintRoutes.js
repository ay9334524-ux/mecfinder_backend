const express = require('express');
const router = express.Router();
const complaintController = require('../controller/complaint.controller');
const { authenticateToken, requireRole, requireMechanic } = require('../middleware/jwt.middleware');
const { validate, complaintValidations } = require('../utils/validation');

const requireAdmin = requireRole('ADMIN', 'SUPER_ADMIN');

// Admin routes (must come before generic routes)
router.get('/admin/all', authenticateToken, requireAdmin, complaintController.getAllComplaints);
router.get('/admin/:id', authenticateToken, requireAdmin, complaintController.getComplaintDetailsAdmin);
router.put('/admin/:id', authenticateToken, requireAdmin, validate(complaintValidations.updateAdmin), complaintController.updateComplaintStatus);

// Mechanic routes
router.get('/mechanic/my-complaints', authenticateToken, requireMechanic, complaintController.getMechanicComplaints);

// User routes - create and view own complaints
router.post('/', authenticateToken, validate(complaintValidations.create), complaintController.createComplaint);
router.get('/', authenticateToken, complaintController.getUserComplaints);
router.get('/:id', authenticateToken, complaintController.getComplaintDetails);

module.exports = router;
