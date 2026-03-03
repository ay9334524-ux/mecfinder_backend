const axios = require('axios');
const twilio = require('twilio');

// Security: All credentials must come from environment variables
// DO NOT hardcode credentials in source code
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || 'whatsapp:+14155238886'; // Twilio Sandbox WhatsApp number
const TWILIO_MESSAGING_SERVICE_SID = process.env.TWILIO_MESSAGING_SERVICE_SID;

// DEV MODE: Only enable if EXPLICITLY set via DEV_OTP=true AND not production
// SECURITY: In production, this MUST be disabled
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_MODE = !IS_PRODUCTION && process.env.DEV_OTP === 'true';

// TEST OTP: Allow 123456 as a valid OTP for testing (can be disabled via DISABLE_TEST_OTP=true)
const ALLOW_TEST_OTP = process.env.DISABLE_TEST_OTP !== 'true';
const TEST_OTP = '123456';

// Generate random 6-digit OTP
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

// In-memory OTP storage (should use Redis in production)
const otpStore = new Map();

// Startup validation
if (IS_PRODUCTION) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('❌ FATAL: Twilio credentials required in production');
    process.exit(1);
  }
  console.log('✅ Twilio WhatsApp OTP service configured for production');
  if (ALLOW_TEST_OTP) {
    console.log('⚠️ TEST OTP (123456) is enabled. Set DISABLE_TEST_OTP=true to disable.');
  }
} else if (DEV_MODE) {
  console.warn('⚠️ DEV MODE: Generating OTP via WhatsApp - NOT FOR PRODUCTION!');
  if (ALLOW_TEST_OTP) {
    console.log('📱 TEST OTP (123456) is enabled for testing');
  }
} else if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn('⚠️ Twilio credentials not configured. Set DEV_OTP=true to use dev mode.');
  if (ALLOW_TEST_OTP) {
    console.log('📱 TEST OTP (123456) is enabled for testing');
  }
}

// Initialize Twilio client
const client = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

const sendOtp = async (phone) => {
  try {
    // Generate OTP
    const otp = generateOtp();
    
    console.log(`📱 Generating OTP for ${phone}: ${otp}`);

    // Format phone number for WhatsApp (ensure it's in E.164 format)
    const formattedPhone = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;

    // DEV MODE: Log OTP instead of sending
    if (DEV_MODE) {
      console.log(`📱 [DEV MODE] WhatsApp OTP for ${phone}: ${otp}`);
      otpStore.set(phone, { otp, attempts: 0, expiresAt: Date.now() + 5 * 60 * 1000 });
      return {
        success: true,
        status: 'pending',
        sid: 'dev-mode-sid',
        message: 'OTP generated for development'
      };
    }

    // Production: Send via Twilio WhatsApp API
    if (!client) {
      throw new Error('Twilio client not initialized');
    }

    const message = await client.messages.create({
      from: TWILIO_PHONE_NUMBER,
      to: formattedPhone,
      body: `Your MecFinder verification code is: ${otp}\n\nThis code will expire in 5 minutes.`
    });

    console.log(`✅ OTP sent via WhatsApp to ${phone}, SID: ${message.sid}`);

    // Store OTP with expiry (5 minutes)
    otpStore.set(phone, { 
      otp, 
      attempts: 0, 
      expiresAt: Date.now() + 5 * 60 * 1000,
      sid: message.sid
    });

    return {
      success: true,
      status: 'sent',
      sid: message.sid,
      message: 'OTP sent via WhatsApp'
    };
  } catch (error) {
    console.error('❌ Twilio WhatsApp Send OTP Error:', error.message);
    return {
      success: false,
      error: error.message || 'Failed to send OTP via WhatsApp'
    };
  }
};

const verifyOtp = async (phone, code) => {
  try {
    // TEST OTP: Allow 123456 for testing purposes (can be disabled in production)
    if (ALLOW_TEST_OTP && code.toString().trim() === TEST_OTP) {
      console.log(`✅ TEST OTP (123456) accepted for ${phone}`);
      // Clean up any existing OTP data for this phone
      otpStore.delete(phone);
      return {
        success: true,
        status: 'approved',
        valid: true,
        testMode: true
      };
    }

    const otpData = otpStore.get(phone);

    // Check if OTP exists
    if (!otpData) {
      console.log(`❌ No OTP found for ${phone}`);
      return {
        success: false,
        status: 'denied',
        valid: false,
        error: 'OTP not found or expired'
      };
    }

    // Check if OTP has expired
    if (Date.now() > otpData.expiresAt) {
      console.log(`❌ OTP expired for ${phone}`);
      otpStore.delete(phone);
      return {
        success: false,
        status: 'expired',
        valid: false,
        error: 'OTP has expired'
      };
    }

    // Check maximum attempts (3 attempts allowed)
    if (otpData.attempts >= 3) {
      console.log(`❌ Max attempts exceeded for ${phone}`);
      otpStore.delete(phone);
      return {
        success: false,
        status: 'denied',
        valid: false,
        error: 'Maximum OTP verification attempts exceeded'
      };
    }

    // Verify OTP
    const isValid = code.toString().trim() === otpData.otp.toString().trim();

    if (isValid) {
      console.log(`✅ OTP verified successfully for ${phone}`);
      otpStore.delete(phone); // Delete after successful verification
      return {
        success: true,
        status: 'approved',
        valid: true
      };
    } else {
      console.log(`❌ Invalid OTP for ${phone}. Attempt: ${otpData.attempts + 1}/3`);
      otpData.attempts++;
      
      return {
        success: false,
        status: 'denied',
        valid: false,
        error: `Invalid OTP. Attempts remaining: ${3 - otpData.attempts}`
      };
    }
  } catch (error) {
    console.error('❌ Twilio WhatsApp Verify OTP Error:', error.message);
    return {
      success: false,
      error: error.message || 'Failed to verify OTP'
    };
  }
};

module.exports = {
  sendOtp,
  verifyOtp
};
