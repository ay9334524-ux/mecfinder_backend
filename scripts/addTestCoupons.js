const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
require('dotenv').config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const addTestCoupons = async () => {
  try {
    // Get any admin ID from database or use a dummy one
    const adminId = new mongoose.Types.ObjectId();
    
    const testCoupons = [
      {
        code: 'SAVE50',
        description: 'Save ₹50 on any service',
        discountType: 'FIXED',
        discountValue: 50,
        maxUsagePerUser: 5,
        minOrderAmount: 200,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        isActive: true,
        createdBy: adminId,
      },
      {
        code: 'FLAT10',
        description: '10% discount on all services',
        discountType: 'PERCENTAGE',
        discountValue: 10,
        maxUsagePerUser: 3,
        minOrderAmount: 300,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        isActive: true,
        createdBy: adminId,
      },
      {
        code: 'WELCOME20',
        description: '20% off on first booking',
        discountType: 'PERCENTAGE',
        discountValue: 20,
        maxUsagePerUser: 1,
        maxDiscountAmount: 200,
        minOrderAmount: 100,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        isActive: true,
        createdBy: adminId,
      },
    ];
    
    console.log('\n🔧 Adding test coupons...\n');
    
    for (const couponData of testCoupons) {
      const existing = await Coupon.findOne({ code: couponData.code });
      if (existing) {
        console.log(`⏭️  ${couponData.code} already exists - skipping`);
      } else {
        const coupon = new Coupon(couponData);
        await coupon.save();
        console.log(`✅ Created ${coupon.code}: ${coupon.discountValue}${coupon.discountType === 'PERCENTAGE' ? '%' : '₹'} off`);
      }
    }
    
    console.log('\n📋 All coupons:');
    const allCoupons = await Coupon.find().select('code discountType discountValue isActive expiresAt');
    allCoupons.forEach((c, i) => {
      const isExpired = c.expiresAt < new Date() ? '❌ EXPIRED' : '✅ ACTIVE';
      console.log(`${i + 1}. ${c.code}: ${c.discountValue}${c.discountType === 'PERCENTAGE' ? '%' : '₹'} | ${isExpired}`);
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Done');
  }
};

(async () => {
  await connectDB();
  await addTestCoupons();
})();
