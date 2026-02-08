const express = require('express');
const router = express.Router();
const helpController = require('../controller/help.controller');
const { authenticateToken, authenticateMechanic } = require('../middleware/jwt.middleware');

// Public routes (no auth required)
router.get('/faq', helpController.getFAQs);
router.get('/faq/search', helpController.searchFAQs);
router.get('/contact', helpController.getContactInfo);

// Feedback route (no auth, but can be authenticated)
router.post('/faq/:id/helpful', helpController.markFAQHelpful);

// Protected routes for users
const protectedRouter = express.Router();

// Middleware to accept both user and mechanic
const authenticateAny = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  
  // Try user auth
  try {
    await new Promise((resolve, reject) => {
      authenticateToken(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return next();
  } catch (e) {
    // Try mechanic auth
    try {
      await new Promise((resolve, reject) => {
        authenticateMechanic(req, res, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      return next();
    } catch (e2) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
  }
};

protectedRouter.use(authenticateAny);
protectedRouter.post('/ticket', helpController.createTicket);
protectedRouter.get('/tickets', helpController.getMyTickets);
protectedRouter.get('/ticket/:id', helpController.getTicketDetails);
protectedRouter.post('/ticket/:id/reply', helpController.addTicketReply);

router.use(protectedRouter);

module.exports = router;
