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

const fixCoupons = async () => {
  try {
    console.log('\n📋 Current Coupons in Database:');
    const coupons = await Coupon.find().select('code discountType discountValue isActive expiresAt');
    
    if (coupons.length === 0) {
      console.log('❌ No coupons found in database');
      console.log('\n🔧 Creating default test coupons...\n');
      
      // Create test coupons
      const testCoupons = [
        {
          code: 'SAVE50',
          description: 'Save ₹50 on any service',
          discountType: 'FIXED',
          discountValue: 50,
          maxUsagePerUser: 1,
          minOrderAmount: 200,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          isActive: true,
          createdBy: new mongoose.Types.ObjectId(),
        },
        {
          code: 'FLAT10',
          description: '10% discount on all services',
          discountType: 'PERCENTAGE',
          discountValue: 10,
          maxUsagePerUser: 2,
          minOrderAmount: 300,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          isActive: true,
          createdBy: new mongoose.Types.ObjectId(),
        },
        {
          code: 'WELCOME20',
          description: '20% off on first booking',
          discountType: 'PERCENTAGE',
          discountValue: 20,
          maxUsagePerUser: 1,
          maxDiscountAmount: 200,
          minOrderAmount: 100,
          expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days
          isActive: true,
          createdBy: new mongoose.Types.ObjectId(),
        },
      ];
      
      const created = await Coupon.insertMany(testCoupons);
      console.log('✅ Created test coupons:');
      created.forEach(coupon => {
        console.log(`   - ${coupon.code}: ${coupon.discountValue}${coupon.discountType === 'PERCENTAGE' ? '%' : '₹'}`);
      });
      return;
    }

    coupons.forEach((coupon, index) => {
      const now = new Date();
      const expired = coupon.expiresAt < now ? '❌ EXPIRED' : '✅ ACTIVE';
      console.log(`${index + 1}. ${coupon.code}`);
      console.log(`   Discount: ${coupon.discountValue}${coupon.discountType === 'PERCENTAGE' ? '%' : '₹'}`);
      console.log(`   Status: ${coupon.isActive ? 'ENABLED' : 'DISABLED'} | ${expired}`);
      console.log('');
    });

    // Fix coupons with 0 discount
    const zeroCoupons = coupons.filter(c => c.discountValue === 0);
    if (zeroCoupons.length > 0) {
      console.log(`\n⚠️  Found ${zeroCoupons.length} coupons with 0 discount:`);
      zeroCoupons.forEach(c => console.log(`   - ${c.code}`));
      
      console.log('\n🔧 Fixing coupons with 0 discount...');
      
      // Define fixes
      const fixes = {
        'SAVE50': { discountType: 'FIXED', discountValue: 50 },
        'FLAT10': { discountType: 'PERCENTAGE', discountValue: 10 },
        'WELCOME20': { discountType: 'PERCENTAGE', discountValue: 20 },
        'SAVE100': { discountType: 'FIXED', discountValue: 100 },
        'GET30': { discountType: 'PERCENTAGE', discountValue: 30 },
      };
      
      for (const coupon of zeroCoupons) {
        const fix = fixes[coupon.code];
        if (fix) {
          await Coupon.updateOne(
            { _id: coupon._id },
            fix
          );
          console.log(`   ✅ Fixed ${coupon.code}: Set to ${fix.discountValue}${fix.discountType === 'PERCENTAGE' ? '%' : '₹'}`);
        } else {
          console.log(`   ⏭️  No fix defined for ${coupon.code} - skipping`);
        }
      }
    } else {
      console.log('\n✅ All coupons have valid discount values');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');
  }
};

(async () => {
  await connectDB();
  await fixCoupons();
})();
