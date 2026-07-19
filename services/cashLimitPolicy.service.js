const MechanicDebt = require('../models/MechanicDebt');
const MechanicEarning = require('../models/MechanicEarning');
const PlatformSettings = require('../models/PlatformSettings');
const Mechanic = require('../models/Mechanic');
const { logger } = require('./logger.service');

class CashLimitPolicyService {
  async canAcceptCashJob(mechanicId) {
    const settings = await PlatformSettings.get();
    const { maxConsecutiveCashJobs, maxCashJobsPerDay, blockOnDebtOverdue } = settings.cash;

    // Check active debt first
    if (blockOnDebtOverdue) {
      const totalDebt = await MechanicDebt.getTotalActiveDebt(mechanicId);
      if (totalDebt > 0) {
        return {
          allowed: false,
          reason: 'ACTIVE_DEBT',
          message: `Clear ₹${totalDebt} platform fee before accepting cash jobs.`,
        };
      }
    }

    // Check consecutive cash jobs
    const recentEarnings = await MechanicEarning.find({
      mechanicId,
      type: 'JOB',
    }).sort({ createdAt: -1 }).limit(maxConsecutiveCashJobs).select('paymentMethod');

    const consecutiveCash = recentEarnings.filter(e => e.paymentMethod === 'CASH').length;
    if (consecutiveCash >= maxConsecutiveCashJobs) {
      return {
        allowed: false,
        reason: 'MAX_CONSECUTIVE_CASH',
        message: `Maximum ${maxConsecutiveCashJobs} consecutive cash jobs reached. Next job must be online payment.`,
        consecutiveCash,
        limit: maxConsecutiveCashJobs,
      };
    }

    // Check daily cash job limit
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const cashJobsToday = await MechanicEarning.countDocuments({
      mechanicId,
      type: 'JOB',
      paymentMethod: 'CASH',
      createdAt: { $gte: todayStart },
    });

    if (cashJobsToday >= maxCashJobsPerDay) {
      return {
        allowed: false,
        reason: 'MAX_DAILY_CASH',
        message: `Daily cash job limit (${maxCashJobsPerDay}) reached. Accept online payments only.`,
        cashJobsToday,
        limit: maxCashJobsPerDay,
      };
    }

    return { allowed: true, consecutiveCash, cashJobsToday };
  }

  async getMechanicCashStatus(mechanicId) {
    const settings = await PlatformSettings.get();
    const policy = await this.canAcceptCashJob(mechanicId);
    return {
      ...policy,
      settings: {
        maxConsecutive: settings.cash.maxConsecutiveCashJobs,
        maxDaily: settings.cash.maxCashJobsPerDay,
      },
    };
  }
}

module.exports = new CashLimitPolicyService();
