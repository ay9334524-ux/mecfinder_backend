/**
 * DEPRECATED: Twilio OTP service has been replaced by Firebase Phone Authentication.
 *
 * OTP is now handled entirely on the client via the Firebase SDK.
 * The backend verifies the resulting Firebase ID token using firebase-admin.
 *
 * This file is kept only to avoid import errors in any leftover references
 * and will be removed in the next cleanup pass.
 */

const sendOtp = async (phone) => {
  console.warn('⚠️ twilioService.sendOtp() called but Twilio has been removed. Use Firebase Phone Auth.');
  return { success: false, error: 'Twilio has been replaced by Firebase Phone Auth' };
};

const verifyOtp = async (phone, code) => {
  console.warn('⚠️ twilioService.verifyOtp() called but Twilio has been removed. Use Firebase Phone Auth.');
  return { success: false, error: 'Twilio has been replaced by Firebase Phone Auth' };
};

module.exports = { sendOtp, verifyOtp };
