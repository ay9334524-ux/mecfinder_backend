const Razorpay = require('razorpay');
const crypto = require('crypto');

function formatRzpError(error) {
  const body = error?.error || error?.response?.data?.error || error?.response?.error;
  if (body?.description) {
    return [body.field, body.code].filter(Boolean).join(' ')
      ? `${body.code || ''}: ${body.description}`.trim()
      : body.description;
  }
  return error.message || String(error);
}

/** Razorpay Payment Link customer.contact expects E.164 (e.g. +919876543210). */
function normalizeRazorpayContact(raw) {
  if (raw == null || raw === '') return '+919999999999';
  const s = String(raw).trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `+91${digits.slice(1)}`;
  if (s.startsWith('+') && digits.length >= 10) return `+${digits}`;
  if (digits.length >= 10) return `+${digits}`;
  return '+919999999999';
}

/** Convert INR rupees → paise integer (avoids float dust). Minimum ₹1. */
function rupeesToPaise(rupees) {
  const n = Number(rupees);
  if (Number.isNaN(n) || n < 1) {
    throw new Error('Amount must be at least ₹1');
  }
  return Math.round(n * 100);
}

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
   * Verify Razorpay payment signature
   * @param {String} orderId
   * @param {String} paymentId
   * @param {String} signature
   * @returns {Boolean}
   */
  verifyPayment(orderId, paymentId, signature) {
    try {
      const secret = process.env.RAZORPAY_KEY_SECRET;
      if (!secret) throw new Error('RAZORPAY_KEY_SECRET not configured');
      const generatedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const isValid = generatedSignature === signature;
      return { success: isValid, error: isValid ? undefined : 'Signature mismatch' };
    } catch (error) {
      console.error('Razorpay verification error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create Payment Link
   * @param {Object} options Payment link details
   * @param {Number} options.amount Amount in INR
   * @param {String} options.referenceId Booking ID
   * @param {String} options.description Description of payment
   * @param {Object} options.customer Customer details (name, email, contact)
   * @returns {Promise<Object>}
   */
  async createPaymentLink({ amount, referenceId, description, customer = {}, notes = {}, callbackUrl }) {
    try {
      const stringNotes = Object.fromEntries(
        Object.entries(notes || {}).map(([k, v]) => [k, v == null ? '' : String(v)]),
      );

      const paymentLinkReq = {
        amount: rupeesToPaise(amount),
        currency: 'INR',
        accept_partial: false,
        description: (description || `Payment for ${referenceId}`).slice(0, 255),
        reference_id: String(referenceId).slice(0, 40),
        customer: {
          name: (customer.name || 'Customer').slice(0, 50),
          email: customer.email || 'customer@mecfinder.com',
          contact: normalizeRazorpayContact(customer.contact),
        },
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: stringNotes,
        ...(callbackUrl ? { callback_url: callbackUrl, callback_method: 'get' } : {}),
      };

      const paymentLink = await this.getInstance().paymentLink.create(paymentLinkReq);
      return {
        success: true,
        paymentLink: {
          id: paymentLink.id,
          short_url: paymentLink.short_url,
          amount: paymentLink.amount / 100,
          status: paymentLink.status,
          reference_id: paymentLink.reference_id,
        },
      };
    } catch (error) {
      console.error('Razorpay create payment link error:', formatRzpError(error));
      return {
        success: false,
        error: formatRzpError(error),
      };
    }
  }

  /**
   * Fetch payment link details
   * @param {String} paymentLinkId - Payment Link ID
   * @returns {Promise<Object>} Payment Link details
   */
  async fetchPaymentLink(paymentLinkId) {
    try {
      const paymentLink = await this.getInstance().paymentLink.fetch(paymentLinkId);
      return {
        success: true,
        paymentLink: {
          id: paymentLink.id,
          status: paymentLink.status,
          amount: paymentLink.amount / 100,
          amount_paid: paymentLink.amount_paid / 100,
          payments: paymentLink.payments, // Array of payment objects
        },
      };
    } catch (error) {
      console.error('Razorpay fetch payment link error:', formatRzpError(error));
      return {
        success: false,
        error: formatRzpError(error),
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
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      
      // If no webhook secret configured, reject webhook
      if (!webhookSecret || webhookSecret === 'your_webhook_secret_here') {
        console.warn('⚠️ Webhook secret not configured - skipping validation');
        return false;
      }

      const expectedSignature = crypto
        .createHmac('sha256', webhookSecret)
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

  async createUpiQrCode({ amount, bookingId, mechanicId, bookingCode, description }) {
    try {
      const rzp = this.getInstance();
      const qrCode = await rzp.qrCode.create({
        type: 'upi_qr',
        name: description || `MecFinder Payment - ${bookingCode}`,
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: rupeesToPaise(amount),
        description: (description || `Payment for ${bookingCode}`).slice(0, 255),
        close_by: Math.floor(Date.now() / 1000) + 1800,
        notes: {
          bookingId,
          mechanicId,
          purpose: 'JOB_PAYMENT',
        },
      });
      return {
        success: true,
        qr: {
          id: qrCode.id,
          image_url: qrCode.image_url,
          short_url: qrCode.short_url,
          amount,
          status: qrCode.status,
        },
      };
    } catch (error) {
      console.error('Razorpay QR code error:', formatRzpError(error));
      return { success: false, error: formatRzpError(error) };
    }
  }

  async payoutToVpa({ vpa, accountHolderName, amount, reference, narration, phone, email }) {
    try {
      const rzpAccountNumber = process.env.RAZORPAYX_PAYOUT_ACCOUNT_NUMBER;
      if (!rzpAccountNumber) {
        return { success: false, error: 'RAZORPAYX_PAYOUT_ACCOUNT_NUMBER not configured' };
      }

      const rzp = this.getInstance();

      const contact = await rzp.contacts.create({
        name: accountHolderName || 'Mechanic',
        email: email || 'mechanic@mecfinder.com',
        contact: normalizeRazorpayContact(phone),
        type: 'vendor',
        reference_id: reference,
      });

      const fundAccount = await rzp.fundAccount.create({
        contact_id: contact.id,
        account_type: 'vpa',
        vpa: { address: vpa },
      });

      const payout = await rzp.payouts.create({
        account_number: rzpAccountNumber,
        fund_account_id: fundAccount.id,
        amount: rupeesToPaise(amount),
        currency: 'INR',
        mode: 'UPI',
        purpose: 'payout',
        queue_if_low_balance: true,
        reference_id: reference,
        narration: (narration || 'MecFinder Payout').slice(0, 30),
      });

      return {
        success: true,
        payout: {
          id: payout.id,
          amount: payout.amount / 100,
          status: payout.status,
          reference: payout.reference_id,
        },
      };
    } catch (error) {
      console.error('Razorpay UPI payout error:', formatRzpError(error));
      return { success: false, error: formatRzpError(error) };
    }
  }
}

module.exports = new RazorpayService();
