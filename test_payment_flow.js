#!/usr/bin/env node
/**
 * Test payment flow: confirmPayment → earnings creation → wallet update
 * This script tests the complete CASH payment flow
 */

const mongoose = require('mongoose');

// Load models
const Booking = require('./models/Booking');
const Mechanic = require('./models/Mechanic');
const MechanicEarning = require('./models/MechanicEarning');
const MechanicDebt = require('./models/MechanicDebt');
const User = require('./models/User');

// Load services
const cashflowSettlementService = require('./services/cashflowSettlement.service');
const earningsController = require('./controller/earnings.controller');

// MongoDB connection (align with index.js: MONGO_URI is canonical; fall back to legacy MONGODB_URI for local scripts).
const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/mecfinder';

async function connectDB() {
  try {
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }
}

async function testPaymentFlow() {
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('🧪 PAYMENT FLOW TEST');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    // Step 1: Find a mechanic with a completed booking
    console.log('📍 Step 1: Finding test data...');
    const booking = await Booking.findOne({ status: 'COMPLETED', paymentStatus: 'PENDING' })
      .populate('mechanicId')
      .populate('userId');

    if (!booking) {
      console.log('❌ No completed bookings with pending payment found');
      console.log('   Need a booking with status=COMPLETED and paymentStatus=PENDING');
      
      // Let's show what bookings exist
      const allBookings = await Booking.find().limit(5);
      console.log('\n   Available bookings:');
      allBookings.forEach(b => {
        console.log(`   - ${b._id}: status=${b.status}, paymentStatus=${b.paymentStatus}`);
      });
      return;
    }

    console.log(`✅ Found booking: ${booking._id}`);
    console.log(`   Mechanic: ${booking.mechanicId.name} (${booking.mechanicId._id})`);
    console.log(`   User: ${booking.userId.name} (${booking.userId._id})`);
    console.log(`   Amount: ₹${booking.pricing?.totalAmount}`);
    console.log(`   Mechanic Earning: ₹${booking.pricing?.mechanicEarning}`);
    console.log(`   Company Earning: ₹${booking.pricing?.companyEarning}`);

    // Step 2: Check current earnings before payment
    console.log('\n📍 Step 2: Checking current earnings...');
    const earningsBefore = await MechanicEarning.find({
      mechanicId: booking.mechanicId._id,
    });
    console.log(`   Total earnings records: ${earningsBefore.length}`);
    const totalBefore = earningsBefore.reduce((sum, e) => sum + (e.netAmount || 0), 0);
    console.log(`   Total net amount: ₹${totalBefore}`);

    // Step 3: Check wallet balance before
    console.log('\n📍 Step 3: Checking wallet balance before payment...');
    const walletBefore = await cashflowSettlementService.getMechanicWalletBalance(
      booking.mechanicId._id.toString()
    );
    console.log(`   Wallet balance: ₹${walletBefore.balance}`);
    console.log(`   Total debt: ₹${walletBefore.totalDebt}`);
    console.log(`   Is negative: ${walletBefore.isNegative}`);

    // Step 4: Simulate CASH payment confirmation
    console.log('\n📍 Step 4: Simulating CASH payment confirmation...');
    console.log(`   Creating earning for mechanic...`);

    try {
      const earning = await earningsController.createEarning({
        bookingId: booking._id,
        bookingCode: booking.bookingId,
        mechanicId: booking.mechanicId._id,
        grossAmount: booking.pricing?.mechanicEarning || 0,
        platformFeePercent: 0,
        platformFeeAmount: 0,
        gstOnPlatformFee: 0,
        netAmount: booking.pricing?.mechanicEarning || 0,
        serviceDetails: {
          name: booking.serviceSnapshot?.name || 'Service',
          category: booking.serviceSnapshot?.categoryName || 'General',
        },
        customerName: booking.userId.name,
        customerPhone: booking.userId.phone || '',
        location: {
          address: booking.location?.address || '',
        },
        paymentMethod: 'CASH',
        paymentStatus: 'PENDING_DEBT_CLEARANCE',
      });
      console.log(`✅ Earning created: ${earning._id}`);
      console.log(`   Amount: ₹${earning.netAmount}`);
    } catch (error) {
      console.error(`❌ Earning creation failed: ${error.message}`);
      return;
    }

    // Step 5: Check wallet balance after
    console.log('\n📍 Step 5: Checking wallet balance after payment...');
    const walletAfter = await cashflowSettlementService.getMechanicWalletBalance(
      booking.mechanicId._id.toString()
    );
    console.log(`   Wallet balance: ₹${walletAfter.balance}`);
    console.log(`   Total debt: ₹${walletAfter.totalDebt}`);
    console.log(`   Is negative: ${walletAfter.isNegative}`);

    // Step 6: Verify earnings were added
    console.log('\n📍 Step 6: Verifying earnings records...');
    const earningsAfter = await MechanicEarning.find({
      mechanicId: booking.mechanicId._id,
    });
    console.log(`   Total earnings records: ${earningsAfter.length}`);
    const totalAfter = earningsAfter.reduce((sum, e) => sum + (e.netAmount || 0), 0);
    console.log(`   Total net amount: ₹${totalAfter}`);

    // Step 7: Check specific earning for this booking
    console.log('\n📍 Step 7: Checking earnings for this booking...');
    const bookingEarnings = await MechanicEarning.findOne({ bookingId: booking._id });
    if (bookingEarnings) {
      console.log(`✅ Earning found for this booking`);
      console.log(`   Net amount: ₹${bookingEarnings.netAmount}`);
      console.log(`   Status: ${bookingEarnings.status}`);
      console.log(`   Available at: ${bookingEarnings.availableAt}`);
    } else {
      console.log(`❌ No earning found for this booking`);
    }

    // Step 8: Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('📊 SUMMARY');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Wallet before: ₹${walletBefore.balance}`);
    console.log(`Earning added: ₹${booking.pricing?.mechanicEarning || 0}`);
    console.log(`Wallet after: ₹${walletAfter.balance}`);
    console.log(`Difference: ₹${walletAfter.balance - walletBefore.balance}`);

    if (walletAfter.balance === walletBefore.balance + (booking.pricing?.mechanicEarning || 0)) {
      console.log('\n✅ PAYMENT FLOW WORKING CORRECTLY');
    } else {
      console.log('\n❌ PAYMENT FLOW HAS ISSUES');
      console.log(`   Expected wallet increase: ₹${booking.pricing?.mechanicEarning || 0}`);
      console.log(`   Actual wallet increase: ₹${walletAfter.balance - walletBefore.balance}`);
    }
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

async function main() {
  await connectDB();
  await testPaymentFlow();
  await mongoose.connection.close();
  console.log('\n✅ Test completed\n');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
