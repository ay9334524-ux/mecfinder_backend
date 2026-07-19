const mongoose = require('mongoose');
require('dotenv').config();

const Review = require('../models/Review');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Mechanic = require('../models/Mechanic');
const Service = require('../models/Service');

async function createSampleReviews() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Get sample data
    const bookings = await Booking.find().limit(10);
    const users = await User.find().limit(10);
    const mechanics = await Mechanic.find().limit(10);
    const services = await Service.find().limit(10);

    if (bookings.length === 0 || users.length === 0 || mechanics.length === 0 || services.length === 0) {
      console.log('Not enough data to create reviews');
      console.log(`Bookings: ${bookings.length}, Users: ${users.length}, Mechanics: ${mechanics.length}, Services: ${services.length}`);
      process.exit(1);
    }

    // Create sample reviews
    const reviews = [];
    const titles = ['Great service!', 'Good work', 'Excellent mechanic', 'Very satisfied', 'Professional', 'Amazing experience', 'Highly recommended', 'Perfect service', 'Best mechanic', 'Outstanding work'];
    const descriptions = [
      'The mechanic was very professional and quick with the service',
      'Service was completed on time and quality was excellent',
      'Excellent quality of work, will definitely come back',
      'Highly recommended for all car maintenance needs',
      'Professional service from start to finish',
      'Amazing experience, very efficient mechanic',
      'Highly recommend this mechanic to everyone',
      'Perfect service, fair pricing, great experience',
      'Best mechanic I have worked with',
      'Outstanding work quality and customer service'
    ];

    for (let i = 0; i < 15; i++) {
      const rating = ((i % 5) + 1);
      reviews.push({
        bookingId: bookings[i % bookings.length]._id,
        userId: users[i % users.length]._id,
        mechanicId: mechanics[i % mechanics.length]._id,
        serviceId: services[i % services.length]._id,
        rating: rating,
        title: titles[i % titles.length],
        description: descriptions[i % descriptions.length],
        status: i % 3 === 0 ? 'PENDING' : 'APPROVED',
        ratingBreakdown: {
          workQuality: rating,
          timelinessAndPunctuality: ((i % 4) + 2),
          professionalism: rating,
          communication: ((i % 4) + 2),
        }
      });
    }

    const createdReviews = await Review.insertMany(reviews);
    console.log(`Created ${createdReviews.length} sample reviews`);

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

createSampleReviews();
