const Razorpay = require('razorpay');
const crypto = require('crypto');

class RazorpayService {
  constructor() {
    this.razorpay = null;
  }

  /**
   * Initialize Razorpay instance (lazy loading)
   */
  getInstance() {
    if (!this.razorpay) {
      if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        throw new Error('Razorpay credentials not configured');
      }
      this.razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
    }
    return this.razorpay;
  }

  /**
   * Create a new order for payment
   * @param {Object} options - Order options
   * @returns {Promise<Object>} Razorpay order
   */
  async createOrder(options) {
    const {
      amount, // Amount in paise (₹100 = 10000)
      currency = 'INR',
      receipt,
      notes = {},
    } = options;

    try {
      const order = await this.getInstance().orders.create({
        amount: Math.round(amount * 100), // Convert to paise
        currency,
        receipt: receipt || `order_${Date.now()}`,
        notes,
      });

      return {
        success: true,
        order: {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          receipt: order.receipt,
          status: order.status,
        },
      };
    } catch (error) {
      console.error('Razorpay create order error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Verify payment signature
   * @param {Object} paymentData - Payment data from frontend
   * @returns {Object} Verification result
   */
  verifyPayment(paymentData) {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    } = paymentData;

    try {
      const body = razorpay_order_id + '|' + razorpay_payment_id;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest('hex');

      const isValid = expectedSignature === razorpay_signature;

      return {
        success: isValid,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
      };
    } catch (error) {
      console.error('Razorpay verification error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Fetch payment details
   * @param {String} paymentId - Payment ID
   * @returns {Promise<Object>} Payment details
   */
  async getPayment(paymentId) {
    try {
      const payment = await this.getInstance().payments.fetch(paymentId);
      return {
        success: true,
        payment: {
          id: payment.id,
          amount: payment.amount / 100, // Convert back to rupees
          currency: payment.currency,
          status: payment.status,
          method: payment.method,
          email: payment.email,
          contact: payment.contact,
          createdAt: new Date(payment.created_at * 1000),
        },
      };
    } catch (error) {
      console.error('Razorpay fetch payment error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Initiate refund
   * @param {String} paymentId - Payment ID to refund
   * @param {Number} amount - Amount to refund (optional, full refund if not specified)
   * @param {Object} notes - Additional notes
   * @returns {Promise<Object>} Refund result
   */
  async initiateRefund(paymentId, amount = null, notes = {}) {
    try {
      const refundOptions = {
        notes,
        speed: 'normal',
      };

      if (amount) {
        refundOptions.amount = Math.round(amount * 100); // Convert to paise
      }

      const refund = await this.getInstance().payments.refund(paymentId, refundOptions);

      return {
        success: true,
        refund: {
          id: refund.id,
          paymentId: refund.payment_id,
          amount: refund.amount / 100,
          status: refund.status,
          createdAt: new Date(refund.created_at * 1000),
        },
      };
    } catch (error) {
      console.error('Razorpay refund error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Create a payout to bank account (for mechanic earnings)
   * Note: Requires RazorpayX activation
   * @param {Object} options - Payout options
   * @returns {Promise<Object>} Payout result
   */
  async createPayout(options) {
    const {
      accountNumber,
      ifscCode,
      accountHolderName,
      amount,
      purpose = 'payout',
      narration = 'MecFinder Earnings Payout',
      reference,
    } = options;

    try {
      // First create a fund account (or use existing)
      const fundAccount = await this.getInstance().fundAccount.create({
        contact_id: reference, // Contact ID from RazorpayX
        account_type: 'bank_account',
        bank_account: {
          name: accountHolderName,
          ifsc: ifscCode,
          account_number: accountNumber,
        },
      });

      // Then create payout
      const payout = await this.getInstance().payouts.create({
        account_number: process.env.RAZORPAY_ACCOUNT_NUMBER, // Your RazorpayX account
        fund_account_id: fundAccount.id,
        amount: Math.round(amount * 100),
        currency: 'INR',
        mode: 'IMPS',
        purpose,
        queue_if_low_balance: true,
        reference_id: `PAYOUT_${Date.now()}`,
        narration,
      });

      return {
        success: true,
        payout: {
          id: payout.id,
          amount: payout.amount / 100,
          status: payout.status,
          mode: payout.mode,
          reference: payout.reference_id,
        },
      };
    } catch (error) {
      console.error('Razorpay payout error:', error);
      // For now, return simulated success (RazorpayX needs activation)
      return {
        success: false,
        error: error.message,
        note: 'RazorpayX activation required for live payouts',
      };
    }
  }

  /**
   * Create contact for payouts (RazorpayX)
   * @param {Object} contactInfo - Contact information
   * @returns {Promise<Object>} Contact result
   */
  async createContact(contactInfo) {
    const { name, email, phone, type = 'vendor', reference } = contactInfo;

    try {
      const contact = await this.getInstance().contacts.create({
        name,
        email,
        contact: phone,
        type,
        reference_id: reference,
      });

      return {
        success: true,
        contact: {
          id: contact.id,
          name: contact.name,
          type: contact.type,
        },
      };
    } catch (error) {
      console.error('Razorpay create contact error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get order details
   * @param {String} orderId - Order ID
   * @returns {Promise<Object>} Order details
   */
  async getOrder(orderId) {
    try {
      const order = await this.getInstance().orders.fetch(orderId);
      return {
        success: true,
        order: {
          id: order.id,
          amount: order.amount / 100,
          currency: order.currency,
          status: order.status,
          attempts: order.attempts,
          createdAt: new Date(order.created_at * 1000),
        },
      };
    } catch (error) {
      console.error('Razorpay fetch order error:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Validate webhook signature
   * @param {String} body - Raw request body
   * @param {String} signature - Webhook signature from header
   * @returns {Boolean} Is valid
   */
  validateWebhookSignature(body, signature) {
    try {
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(body)
        .digest('hex');

      return expectedSignature === signature;
    } catch (error) {
      console.error('Webhook validation error:', error);
      return false;
    }
  }

  /**
   * Get Razorpay key for frontend
   * @returns {String} Razorpay Key ID
   */
  getKeyId() {
    return process.env.RAZORPAY_KEY_ID;
  }
}

module.exports = new RazorpayService();
