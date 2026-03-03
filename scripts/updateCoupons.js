const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
require('dotenv').config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

const updateCoupons = async () => {
  try {
    // Set all minimum order amounts to 0
    const result = await Coupon.updateMany({}, { minOrderAmount: 0 });
    console.log(`Updated ${result.modifiedCount} coupons - Set minOrderAmount to 0`);
    
    // Display updated coupons
    const coupons = await Coupon.find().select('code discountType discountValue minOrderAmount maxDiscountAmount');
    console.log('\n📋 Updated Coupons:');
    coupons.forEach((c, i) => {
      const max = c.maxDiscountAmount ? ` (max ₹${c.maxDiscountAmount})` : '';
      console.log(`${i + 1}. ${c.code}: ${c.discountValue}${c.discountType === 'PERCENTAGE' ? '%' : '₹'}${max}`);
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
};

(async () => {
  await connectDB();
  await updateCoupons();
})();
