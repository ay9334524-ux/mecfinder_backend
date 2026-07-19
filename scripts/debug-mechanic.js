const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const db = mongoose.connection.db;
  
  // Check a rated booking
  const booking = await db.collection('bookings').findOne({ rating: { $exists: true } });
  console.log('mechanicId:', booking.mechanicId);
  console.log('mechanicId type:', typeof booking.mechanicId);
  
  // Try to find mechanic directly
  const mechanic = await db.collection('mechanics').findOne({ _id: booking.mechanicId });
  console.log('mechanic found in mechanics collection:', mechanic ? mechanic.name : 'NOT FOUND');
  
  // Check if mechanic exists in users collection instead
  const user = await db.collection('users').findOne({ _id: booking.mechanicId });
  console.log('mechanic found in users collection:', user ? user.name : 'NOT FOUND');
  
  // List sample mechanics
  const mechanics = await db.collection('mechanics').find().limit(3).toArray();
  console.log('\nSample mechanics:');
  mechanics.forEach(m => console.log('  id:', m._id.toString(), 'name:', m.name));
  
  // Check Booking model ref
  console.log('\n--- Checking Booking schema mechanicId ref ---');
  const Booking = require('./models/Booking');
  const schema = Booking.schema;
  const mechanicPath = schema.path('mechanicId');
  console.log('mechanicId ref:', mechanicPath.options.ref);
  
  process.exit(0);
}).catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
