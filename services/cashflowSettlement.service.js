/**
 * Cashflow Settlement Service
 * Handles automatic settlement of payments and debt management
 * 
 * Workflow:
 * 1. CASH Collection: Create debt record, mechanic wallet shows negative
 * 2. ONLINE Payment: Auto-deduct debt from mechanic's earning, rest credited
 * 3. 24-hour Rule: After 24h, mechanic can't book new jobs if debt unpaid
 */

const mongoose = require('mongoose');
const MechanicDebt = require('../models/MechanicDebt');
const MechanicEarning = require('../models/MechanicEarning');
const Wallet = require('../models/Wallet');
const CompanyLedger = require('../models/CompanyLedger');
const Mechanic = require('../models/Mechanic');
const { logger } = require('./logger.service');

class CashflowSettlementService {
  /**
   * Handle CASH payment settlement
   * Creates debt record for mechanic (negative balance)
   */
  async handleCashPaymentSettlement(booking) {
    try {
      const companyEarning = booking.pricing?.companyEarning || 0;
      const mechanicEarning = booking.pricing?.mechanicEarning || 0;

      if (companyEarning <= 0) {
        logger.warn(`No company earning for CASH booking ${booking._id}`);
        return null;
      }

      // Idempotent — prevents duplicate debt (+₹ drift) if confirm-payment is called twice
      const existingDebt = await MechanicDebt.findOne({
        mechanicId: booking.mechanicId,
        bookingId: booking._id,
        status: { $in: ['ACTIVE', 'PARTIAL'] },
      });
      if (existingDebt) {
        logger.warn(`Debt already recorded for booking ${booking._id} — skipping duplicate`);
        return {
          type: 'CASH_DEBT_EXISTS',
          debtAmount: companyEarning,
          mechanicEarning,
          debtId: existingDebt._id,
        };
      }

      // Create debt record for mechanic
      const debt = await MechanicDebt.createDebt(
        booking.mechanicId,
        booking._id,
        companyEarning
      );

      // Block mechanic from getting new rides immediately
      await Mechanic.findByIdAndUpdate(booking.mechanicId, { hasActiveDebt: true });

      logger.info(`💳 CASH Debt Created: Mechanic=${booking.mechanicId}, Amount=₹${companyEarning}, BookingId=${booking._id}`);

      // Mechanic earning is recorded but mechanic owes company back
      return {
        type: 'CASH_DEBT',
        debtAmount: companyEarning,
        mechanicEarning,
        debtId: debt._id,
      };
    } catch (error) {
      logger.error('❌ Error in handleCashPaymentSettlement:', error);
      throw error;
    }
  }

  /**
   * Handle ONLINE payment settlement
   * Auto-deducts pending debt from mechanic earning
   */
  async handleOnlinePaymentSettlement(booking, paymentId) {
    try {
      const mechanicEarning = booking.pricing?.mechanicEarning || 0;
      const companyEarning = booking.pricing?.companyEarning || 0;

      logger.info(`💰 ONLINE Payment Settlement: Mechanic=${booking.mechanicId}, Total=₹${booking.pricing?.totalAmount}`);

      // Get mechanic's active debt
      const totalDebt = await MechanicDebt.getTotalActiveDebt(booking.mechanicId);

      if (totalDebt > 0) {
        logger.info(`   🔴 Mechanic has ₹${totalDebt} debt - auto-deducting...`);

        // Settle debt (FIFO)
        const debtSettlement = await MechanicDebt.settleDebt(
          booking.mechanicId,
          paymentId,
          totalDebt,
          'AUTO_DEDUCT_ONLINE'
        );

        // Mechanic receives: earning - debt
        const mechanicCredit = Math.max(0, mechanicEarning - debtSettlement.deductedAmount);
        const companyReceives = companyEarning + debtSettlement.deductedAmount;

        logger.info(`   ✅ Debt Settlement:
          - Deducted: ₹${debtSettlement.deductedAmount}
          - Mechanic Earning (after debt): ₹${mechanicCredit}
          - Company Receives: ₹${companyReceives}`);

        return {
          type: 'ONLINE_WITH_DEBT_SETTLEMENT',
          grossMechanicEarning: mechanicEarning,
          debtDeducted: debtSettlement.deductedAmount,
          netMechanicCredit: mechanicCredit,
          companyReceives,
          remainingDebt: debtSettlement.remainingDebt,
        };
      } else {
        // No debt - mechanic gets full earning
        logger.info(`   ✅ No debt - Mechanic receives full ₹${mechanicEarning}`);

        return {
          type: 'ONLINE_NO_DEBT',
          mechanicEarning,
          companyEarning,
        };
      }
    } catch (error) {
      logger.error('❌ Error in handleOnlinePaymentSettlement:', error);
      throw error;
    }
  }

  /**
   * Calculate mechanic's wallet balance
   * Available earnings - active debt = wallet balance (can be negative)
   */
  async getMechanicWalletBalance(mechanicId) {
    try {
      const oid = new mongoose.Types.ObjectId(mechanicId);

      const [earningsResult, heldResult] = await Promise.all([
        MechanicEarning.aggregate([
          {
            $match: {
              mechanicId: oid,
              status: { $in: ['AVAILABLE', 'PAID'] },
            },
          },
          {
            $group: {
              _id: null,
              totalAvailable: { $sum: '$netAmount' },
              count: { $sum: 1 },
            },
          },
        ]),
        MechanicEarning.aggregate([
          {
            $match: { mechanicId: oid, status: 'ON_HOLD' },
          },
          {
            $group: {
              _id: null,
              heldTotal: { $sum: '$netAmount' },
            },
          },
        ]),
      ]);

      const totalEarnings = earningsResult[0]?.totalAvailable || 0;
      const onHoldBalance = heldResult[0]?.heldTotal || 0;

      // Active debt
      const totalDebt = await MechanicDebt.getTotalActiveDebt(mechanicId);

      // Balance can be negative (available earnings only − debt).
      const balance = totalEarnings - totalDebt;

      return {
        totalEarnings,
        onHoldBalance,
        totalDebt,
        balance, // Can be negative
        isNegative: balance < 0,
      };
    } catch (error) {
      logger.error('❌ Error calculating wallet balance:', error);
      throw error;
    }
  }

  /**
   * Check if mechanic can book new jobs
   * Cannot book if has ANY active debt
   */
  async canMechanicBook(mechanicId) {
    try {
      // Find ANY active debt
      const totalDebt = await MechanicDebt.getTotalActiveDebt(mechanicId);

      if (totalDebt > 0) {
        return {
          canBook: false,
          reason: `ACTIVE_DEBT`,
          debtAmount: totalDebt,
          message: `You have unpaid debt of ₹${totalDebt}. Please clear it to continue booking.`,
        };
      }

      return { canBook: true };
    } catch (error) {
      logger.error('❌ Error checking booking eligibility:', error);
      throw error;
    }
  }

  /**
   * Get mechanic's debt summary
   */
  async getMechanicDebtSummary(mechanicId) {
    try {
      const debts = await MechanicDebt.find({
        mechanicId,
        status: { $in: ['ACTIVE', 'PARTIAL'] },
      }).sort({ createdAt: 1 });

      const total = debts.reduce((sum, debt) => sum + debt.getRemainingBalance(), 0);
      const overdue = debts.filter(d => d.isOverdue());

      return {
        totalDebt: total,
        activeCount: debts.length,
        overdueCount: overdue.length,
        overdueAmount: overdue.reduce((sum, d) => sum + d.getRemainingBalance(), 0),
        debts: debts.map(d => ({
          id: d._id,
          amount: d.getRemainingBalance(),
          bookingId: d.bookingId,
          createdAt: d.createdAt,
          dueAt: d.dueAt,
          isOverdue: d.isOverdue(),
          status: d.status,
        })),
      };
    } catch (error) {
      logger.error('❌ Error getting debt summary:', error);
      throw error;
    }
  }

  /**
   * Release all ON_HOLD earnings for a mechanic once their debt is fully cleared.
   * ON_HOLD earnings are created for CASH jobs and don't count toward wallet balance
   * until the mechanic pays back the platform commission.
   */
  async releaseOnHoldEarnings(mechanicId) {
    try {
      const result = await MechanicEarning.updateMany(
        {
          mechanicId: new mongoose.Types.ObjectId(mechanicId),
          status: 'ON_HOLD',
        },
        {
          $set: {
            status: 'AVAILABLE',
            availableAt: new Date(),
          },
        }
      );
      logger.info(`✅ Released ${result.modifiedCount} ON_HOLD earnings for mechanic ${mechanicId}`);
      return result.modifiedCount;
    } catch (error) {
      logger.error('❌ Error releasing ON_HOLD earnings:', error);
      throw error;
    }
  }

  /**
   * Auto-settle all mechanic debts during online payment
   * Called during payment verification
   */
  async processPaymentWithAutoSettlement(booking, paymentId) {
    try {
      // Get settlement info
      const settlementInfo = await this.handleOnlinePaymentSettlement(booking, paymentId);

      // Update CompanyLedger with actual received amount
      if (settlementInfo.type === 'ONLINE_WITH_DEBT_SETTLEMENT') {
        await CompanyLedger.findOneAndUpdate(
          { bookingId: booking._id },
          {
            amount: settlementInfo.companyReceives, // Includes debt portion
            settledAmount: settlementInfo.companyReceives,
            status: 'SETTLED',
            settledAt: new Date(),
            settlementDetails: {
              baseEarning: booking.pricing?.companyEarning,
              debtRecovered: settlementInfo.debtDeducted,
              totalReceived: settlementInfo.companyReceives,
            },
          },
          { upsert: true }
        );

        // Mechanic earning reduced by debt payment
        await MechanicEarning.findOneAndUpdate(
          { bookingId: booking._id },
          {
            grossAmount: settlementInfo.netMechanicCredit,
            netAmount: settlementInfo.netMechanicCredit,
            status: settlementInfo.netMechanicCredit > 0 ? 'AVAILABLE' : 'PENDING',
            notes: `Auto-settled debt: ₹${settlementInfo.debtDeducted} deducted`,
          }
        );

        // If remaining debt is 0, unblock the mechanic
        if (settlementInfo.remainingDebt === 0) {
          await Mechanic.findByIdAndUpdate(booking.mechanicId, { hasActiveDebt: false });
          logger.info(`   🔓 Mechanic ${booking.mechanicId} unblocked (debt fully settled)`);
        }
      }

      return settlementInfo;
    } catch (error) {
      logger.error('❌ Error in processPaymentWithAutoSettlement:', error);
      throw error;
    }
  }

  /**
   * Amount locked in payout queue (REQUESTED / ON_HOLD / PROCESSING) — not yet settled.
   */
  async getPendingWithdrawalReserveAmount(mechanicId) {
    const MechanicPayout = require('../models/MechanicPayout');
    const agg = await MechanicPayout.aggregate([
      {
        $match: {
          mechanicId: new mongoose.Types.ObjectId(mechanicId),
          // REQUESTED/ON_HOLD: balance not yet debited — reserve blocks double withdraw.
          // PROCESSING: wallet already debited via MechanicEarning adjustment — do not reserve again.
          status: { $in: ['REQUESTED', 'ON_HOLD'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    return agg[0]?.total || 0;
  }
}

module.exports = new CashflowSettlementService();
