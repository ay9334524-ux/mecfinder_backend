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

const checkCoupons = async () => {
  try {
    const coupons = await Coupon.find().select('code discountType discountValue minOrderAmount');
    
    console.log('\n📋 Coupons:');
    coupons.forEach((c, i) => {
      console.log(`${i + 1}. ${c.code} - Min: ₹${c.minOrderAmount}, Discount: ${c.discountValue}${c.discountType === 'PERCENTAGE' ? '%' : '₹'}`);
    });
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
  }
};

(async () => {
  await connectDB();
  await checkCoupons();
})();
