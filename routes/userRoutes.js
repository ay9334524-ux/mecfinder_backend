const express = require('express');
const router = express.Router();
const userController = require('../controller/user.controller');
const { authenticateToken } = require('../middleware/jwt.middleware');
const { uploadImage, handleMulterError } = require('../middleware/upload.middleware');
const { validate, userValidations } = require('../utils/validation');

// All routes require authentication
router.use(authenticateToken);

// Profile routes
router.get('/profile', userController.getProfile);
router.put('/profile', validate(userValidations.updateProfile), userController.updateProfile);
router.post('/avatar', uploadImage.single('avatar'), handleMulterError, userController.uploadAvatar);
router.put('/location', validate(userValidations.updateLocation), userController.updateLocation);

// Account management
router.delete('/account', userController.deleteAccount);

// Addresses (future feature)
router.get('/addresses', userController.getAddresses);

module.exports = router;
