const axios = require('axios');

// Security: All credentials must come from environment variables
// DO NOT hardcode credentials in source code
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;

// DEV MODE: Only enable if EXPLICITLY set via DEV_OTP=true AND not production
// SECURITY: In production, this MUST be disabled
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEV_MODE = !IS_PRODUCTION && process.env.DEV_OTP === 'true';
const DEV_OTP = '123456';

// Startup validation
if (IS_PRODUCTION) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SID) {
    console.error('❌ FATAL: Twilio credentials required in production');
    process.exit(1);
  }
  console.log('✅ Twilio configured for production');
} else if (DEV_MODE) {
  console.warn('⚠️ DEV MODE: Using fixed OTP 123456 - NOT FOR PRODUCTION!');
} else if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SID) {
  console.warn('⚠️ Twilio credentials not configured. Set DEV_OTP=true to use dev mode.');
}

const TWILIO_BASE_URL = TWILIO_VERIFY_SID 
  ? `https://verify.twilio.com/v2/Services/${TWILIO_VERIFY_SID}`
  : '';

const twilioAuth = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')
  : '';

const sendOtp = async (phone) => {
  // DEV MODE: Skip Twilio, use fixed OTP
  if (DEV_MODE) {
    console.log(`📱 [DEV MODE] OTP for ${phone}: ${DEV_OTP}`);
    return {
      success: true,
      status: 'pending',
      sid: 'dev-mode-sid',
      devOtp: DEV_OTP
    };
  }

  try {
    const response = await axios.post(
      `${TWILIO_BASE_URL}/Verifications`,
      new URLSearchParams({
        To: phone,
        Channel: 'sms'
      }),
      {
        headers: {
          'Authorization': `Basic ${twilioAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return {
      success: true,
      status: response.data.status,
      sid: response.data.sid
    };
  } catch (error) {
    console.error('Twilio Send OTP Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || 'Failed to send OTP'
    };
  }
};

const verifyOtp = async (phone, code) => {
  // DEV MODE: Accept fixed OTP
  if (DEV_MODE) {
    const isValid = code === DEV_OTP;
    console.log(`📱 [DEV MODE] Verifying OTP for ${phone}: ${code} - ${isValid ? '✅ Valid' : '❌ Invalid'}`);
    return {
      success: isValid,
      status: isValid ? 'approved' : 'denied',
      valid: isValid
    };
  }

  try {
    const response = await axios.post(
      `${TWILIO_BASE_URL}/VerificationCheck`,
      new URLSearchParams({
        To: phone,
        Code: code
      }),
      {
        headers: {
          'Authorization': `Basic ${twilioAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    return {
      success: response.data.status === 'approved',
      status: response.data.status,
      valid: response.data.valid
    };
  } catch (error) {
    console.error('Twilio Verify OTP Error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || 'Failed to verify OTP'
    };
  }
};

module.exports = {
  sendOtp,
  verifyOtp
};
