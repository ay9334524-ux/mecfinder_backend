const mongoose = require('mongoose');
const MechanicPayout = require('../models/MechanicPayout');
const MechanicEarning = require('../models/MechanicEarning');
const cashflowSettlementService = require('./cashflowSettlement.service');
const razorpayService = require('./razorpay.service');
const AuditLog = require('../models/AuditLog');
const { logger } = require('./logger.service');

/**
 * Fulfill a mechanic payout: wallet debit + bank (Razorpay IMPS) or UPI settlement record.
 * Used by admin approval and by the delayed auto-queue worker.
 *
 * @param {string|mongoose.Types.ObjectId} payoutId
 * @param {{ adminId?: string|null, source?: 'ADMIN'|'AUTO_QUEUE' }} opts
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, payout?: object, razorpayStatus?: string, error?: string }>}
 */
async function fulfillMechanicPayout(payoutId, opts = {}) {
  const { adminId = null, source = 'ADMIN' } = opts;

  const payout = await MechanicPayout.findById(payoutId);
  if (!payout || !['REQUESTED', 'ON_HOLD'].includes(payout.status)) {
    return { ok: false, skipped: true, reason: 'not_pending' };
  }

  const mechanicId = payout.mechanicId.toString();
  const walletBalance = await cashflowSettlementService.getMechanicWalletBalance(mechanicId);

  if (walletBalance.totalDebt > 0) {
    logger.warn(`[payout] skip ${payoutId}: mechanic has debt`);
    return { ok: false, skipped: true, reason: 'debt' };
  }

  const reserveTotal = await cashflowSettlementService.getPendingWithdrawalReserveAmount(mechanicId);
  if (walletBalance.balance + 1e-6 < reserveTotal) {
    logger.warn(`[payout] skip ${payoutId}: insufficient wallet vs reserve`);
    return { ok: false, skipped: true, reason: 'insufficient_reserve' };
  }

  payout.processedAt = new Date();
  if (adminId) {
    payout.processedBy = new mongoose.Types.ObjectId(adminId);
  }
  payout.fulfillmentSource = source;

  const deductCode = `WD-${payout._id.toString().slice(-8).toUpperCase()}`;

  const deductEarning = await MechanicEarning.create({
    mechanicId: new mongoose.Types.ObjectId(mechanicId),
    bookingCode: deductCode,
    grossAmount: -payout.amount,
    netAmount: -payout.amount,
    type: 'ADJUSTMENT',
    status: 'AVAILABLE',
    serviceDetails: { name: `Withdrawal ${payout.payoutId}` },
    serviceDate: new Date(),
  });

  payout.status = 'PROCESSING';
  await payout.save();

  let razorpayStatus = 'PROCESSING_MANUAL_COMPLETE';

  try {
    const isBankAuto = payout.paymentGateway === 'BANK_TRANSFER' && process.env.RAZORPAY_KEY_ID;
    const isUpi = payout.paymentGateway === 'RAZORPAY';

    if (isUpi) {
      const forceLedger =
        String(process.env.PAYOUT_UPI_LEDGER_ONLY || '').toLowerCase() === 'true'
        || String(process.env.PAYOUT_UPI_LEDGER_ONLY || '') === '1';
      const vpa = payout.bankDetails?.upiId?.trim();
      const netAmt = payout.breakdown?.netAmount ?? payout.amount;
      const hasRzpX = Boolean(process.env.RAZORPAYX_PAYOUT_ACCOUNT_NUMBER);

      if (forceLedger || !hasRzpX) {
        if (forceLedger) {
          logger.warn(`[payout] UPI payout ${payout._id}: PAYOUT_UPI_LEDGER_ONLY — ledger-only (no RazorpayX transfer).`);
          razorpayStatus = 'AUTO_UPI_SETTLED_LEDGER_ONLY';
        } else {
          logger.warn(
            `[payout] UPI payout ${payout._id}: no RAZORPAYX_PAYOUT_ACCOUNT_NUMBER — ledger-only. Set env for real UPI payout.`,
          );
          razorpayStatus = 'AUTO_UPI_LEDGER_FALLBACK';
        }
        payout.status = 'COMPLETED';
        payout.completedAt = new Date();
        payout.transactionId = `UPI-${source}-${Date.now().toString(36)}`;
        await payout.save();
      } else {
        if (!vpa) {
          throw new Error('UPI ID missing on payout record');
        }
        const Mechanic = require('../models/Mechanic');
        const mech = await Mechanic.findById(mechanicId).select('phone email').lean();
        const result = await razorpayService.payoutToVpa({
          vpa,
          accountHolderName: payout.bankDetails.accountHolderName,
          amount: netAmt,
          reference: `PAYOUT_${payout._id}`,
          narration: `MF ${payout.payoutId || payout._id}`.slice(0, 30),
          phone: mech?.phone,
          email: mech?.email,
        });
        if (!result.success) {
          throw new Error(result.error || 'Razorpay UPI payout failed');
        }
        razorpayStatus = 'SENT_TO_UPI_RZP';
        payout.status = 'COMPLETED';
        payout.completedAt = new Date();
        payout.transactionId = result.payout?.reference || result.payout?.id || '';
        payout.razorpayPayoutId = result.payout?.id || '';
        await payout.save();
      }
    } else if (!isBankAuto || !payout.bankDetails?.accountNumber || payout.bankDetails.accountNumber.length < 6) {
      razorpayStatus = payout.paymentGateway === 'BANK_TRANSFER'
        ? 'MANUAL_BANK_PAYOUT_DEBITED'
        : 'MANUAL_TRANSFER_DEBITED';
      payout.status = 'COMPLETED';
      payout.completedAt = new Date();
      payout.transactionId = `MANUAL-${payout.payoutId}`;
      await payout.save();
    } else if (isBankAuto) {
      const acc = payout.bankDetails.accountNumber;
      const ifsc = payout.bankDetails.ifscCode;
      const netAmt = payout.breakdown?.netAmount ?? payout.amount;
      const result = await razorpayService.createPayout({
        accountNumber: acc,
        ifscCode: ifsc,
        accountHolderName: payout.bankDetails.accountHolderName || 'Beneficiary',
        amount: netAmt,
        narration: `MECFINDER ${payout.payoutId}`,
        reference: `PAYOUT_${payout._id}`,
      });
      if (!result.success) {
        throw new Error(result.error || 'Razorpay payout failed');
      }
      payout.razorpayPayoutId = result.payout?.id || '';
      payout.status = 'COMPLETED';
      payout.completedAt = new Date();
      payout.transactionId = result.payout?.reference || payout.payoutId;
      await payout.save();
      razorpayStatus = 'SENT_TO_BANK_RZP';
    }
  } catch (e) {
    razorpayStatus = `ROLLBACK: ${e.message}`;
    logger.error(`[payout] transfer failed ${payoutId}: ${e.message}`);
    await MechanicEarning.create({
      mechanicId: new mongoose.Types.ObjectId(mechanicId),
      bookingCode: `WD-RFND-${Date.now().toString().slice(-6)}`,
      grossAmount: payout.amount,
      netAmount: payout.amount,
      type: 'ADJUSTMENT',
      status: 'AVAILABLE',
      serviceDetails: { name: `Payout reversal ${payout.payoutId}` },
      serviceDate: new Date(),
    });
    await MechanicEarning.findByIdAndDelete(deductEarning._id).catch(() => {});
    payout.status = 'FAILED';
    payout.failureReason = e.message;
    payout.processedAt = new Date();
    await payout.save();
    await AuditLog.create({
      category: 'PAYOUT',
      action: 'PAYOUT_FAILED',
      mechanicId: payout.mechanicId,
      adminId: adminId || undefined,
      amount: payout.amount,
      status: 'FAILED',
      message: e.message,
      meta: { payoutId: payout._id.toString(), source },
    }).catch(() => {});
    return { ok: false, error: e.message, payout };
  }

  await AuditLog.create({
    category: 'PAYOUT',
    action: source === 'AUTO_QUEUE' ? 'PAYOUT_AUTO_FULFILLED' : 'PAYOUT_APPROVED',
    mechanicId: payout.mechanicId,
    adminId: adminId || undefined,
    amount: payout.amount,
    status: payout.status,
    message: razorpayStatus,
    meta: { payoutId: payout._id.toString(), payoutHumanId: payout.payoutId, source },
  }).catch(() => {});

  return { ok: true, payout, razorpayStatus };
}

module.exports = {
  fulfillMechanicPayout,
};
