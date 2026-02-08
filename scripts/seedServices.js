const mongoose = require('mongoose');
require('dotenv').config();

const ServiceCategory = require('../models/ServiceCategory');
const Service = require('../models/Service');

// Helper to create slug from name
const createSlug = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
};

// Map category slug to vehicle types
const categoryVehicleTypes = {
  'bike-scooter': ['BIKE'],
  'car-van': ['CAR'],
  'truck-bus': ['TRUCK'],
  'auto-tempo': ['AUTO'],
};

// Services organized by category
const servicesByCategory = {
  'bike-scooter': [
    { name: 'Oil Change', description: 'Complete engine oil change with filter', basePrice: 299, estimatedTime: 30, icon: '🛢️' },
    { name: 'Tire Puncture Repair', description: 'Puncture repair for tubeless or tube tires', basePrice: 100, estimatedTime: 20, icon: '🔧' },
    { name: 'Battery Jump Start', description: 'Battery jump start service', basePrice: 199, estimatedTime: 15, icon: '🔋' },
    { name: 'Battery Replacement', description: 'Battery replacement with new battery', basePrice: 899, estimatedTime: 30, icon: '🔋' },
    { name: 'Brake Service', description: 'Brake pad check and replacement', basePrice: 399, estimatedTime: 45, icon: '🛑' },
    { name: 'Chain Lubrication', description: 'Chain cleaning and lubrication', basePrice: 149, estimatedTime: 20, icon: '⛓️' },
    { name: 'General Service', description: 'Complete bike service including oil, filter, brakes check', basePrice: 599, estimatedTime: 60, icon: '🔧' },
    { name: 'Clutch Repair', description: 'Clutch plate and cable adjustment/replacement', basePrice: 499, estimatedTime: 45, icon: '⚙️' },
    { name: 'Spark Plug Replacement', description: 'Spark plug check and replacement', basePrice: 199, estimatedTime: 20, icon: '⚡' },
    { name: 'Air Filter Cleaning', description: 'Air filter cleaning or replacement', basePrice: 149, estimatedTime: 15, icon: '💨' },
    { name: 'Carburetor Tuning', description: 'Carburetor cleaning and tuning', basePrice: 349, estimatedTime: 40, icon: '🔩' },
    { name: 'Headlight/Taillight Repair', description: 'Light bulb replacement and wiring check', basePrice: 199, estimatedTime: 20, icon: '💡' },
    { name: 'Kickstart Repair', description: 'Kickstart mechanism repair', basePrice: 299, estimatedTime: 30, icon: '🦵' },
    { name: 'Self Start Motor Repair', description: 'Self start motor check and repair', basePrice: 499, estimatedTime: 45, icon: '🔌' },
    { name: 'Tire Replacement', description: 'New tire fitting and balancing', basePrice: 799, estimatedTime: 30, icon: '🛞' },
  ],

  'car-van': [
    { name: 'Oil Change', description: 'Complete engine oil change with filter', basePrice: 799, estimatedTime: 45, icon: '🛢️' },
    { name: 'Tire Puncture Repair', description: 'Tubeless tire puncture repair', basePrice: 250, estimatedTime: 30, icon: '🔧' },
    { name: 'Battery Jump Start', description: 'Battery jump start and diagnosis', basePrice: 299, estimatedTime: 20, icon: '🔋' },
    { name: 'Battery Replacement', description: 'Battery replacement with warranty', basePrice: 3499, estimatedTime: 30, icon: '🔋' },
    { name: 'Brake Pad Replacement', description: 'Front or rear brake pad replacement', basePrice: 1499, estimatedTime: 60, icon: '🛑' },
    { name: 'AC Gas Refill', description: 'AC gas top-up and leak check', basePrice: 1299, estimatedTime: 45, icon: '❄️' },
    { name: 'AC Repair', description: 'Complete AC system diagnosis and repair', basePrice: 2499, estimatedTime: 120, icon: '❄️' },
    { name: 'General Service', description: 'Complete car service package', basePrice: 2999, estimatedTime: 180, icon: '🔧' },
    { name: 'Wheel Alignment', description: 'Computerized wheel alignment', basePrice: 799, estimatedTime: 45, icon: '🎯' },
    { name: 'Wheel Balancing', description: 'All wheel balancing', basePrice: 499, estimatedTime: 30, icon: '⚖️' },
    { name: 'Clutch Replacement', description: 'Clutch plate and pressure plate replacement', basePrice: 6999, estimatedTime: 240, icon: '⚙️' },
    { name: 'Radiator Repair', description: 'Radiator leak repair and coolant top-up', basePrice: 999, estimatedTime: 60, icon: '🌡️' },
    { name: 'Starter Motor Repair', description: 'Starter motor check and repair', basePrice: 1999, estimatedTime: 90, icon: '🔌' },
    { name: 'Alternator Repair', description: 'Alternator testing and repair', basePrice: 2499, estimatedTime: 90, icon: '⚡' },
    { name: 'Engine Diagnosis', description: 'OBD scanning and diagnosis', basePrice: 499, estimatedTime: 30, icon: '🔍' },
    { name: 'Suspension Repair', description: 'Shock absorber and suspension check', basePrice: 1999, estimatedTime: 120, icon: '🏎️' },
    { name: 'Power Window Repair', description: 'Power window motor and switch repair', basePrice: 999, estimatedTime: 60, icon: '🪟' },
    { name: 'Central Locking Repair', description: 'Central locking system repair', basePrice: 799, estimatedTime: 45, icon: '🔐' },
    { name: 'Car Wash & Detailing', description: 'Complete interior and exterior cleaning', basePrice: 999, estimatedTime: 90, icon: '🧽' },
    { name: 'Tyre Replacement', description: 'New tyre fitting with alignment', basePrice: 2999, estimatedTime: 45, icon: '🛞' },
  ],

  'truck-bus': [
    { name: 'Oil Change', description: 'Heavy duty engine oil change', basePrice: 2499, estimatedTime: 60, icon: '🛢️' },
    { name: 'Tire Puncture Repair', description: 'Heavy vehicle tire repair', basePrice: 499, estimatedTime: 45, icon: '🔧' },
    { name: 'Battery Jump Start', description: 'Heavy duty battery jump start', basePrice: 499, estimatedTime: 30, icon: '🔋' },
    { name: 'Battery Replacement', description: 'Commercial vehicle battery replacement', basePrice: 7999, estimatedTime: 45, icon: '🔋' },
    { name: 'Brake Service', description: 'Air brake system service', basePrice: 3999, estimatedTime: 180, icon: '🛑' },
    { name: 'General Service', description: 'Complete truck service', basePrice: 7999, estimatedTime: 300, icon: '🔧' },
    { name: 'Clutch Replacement', description: 'Heavy duty clutch replacement', basePrice: 14999, estimatedTime: 360, icon: '⚙️' },
    { name: 'Turbo Repair', description: 'Turbocharger service and repair', basePrice: 9999, estimatedTime: 240, icon: '🌀' },
    { name: 'Fuel Injection Service', description: 'Fuel injector cleaning and calibration', basePrice: 4999, estimatedTime: 180, icon: '⛽' },
    { name: 'Radiator Repair', description: 'Heavy duty radiator service', basePrice: 2999, estimatedTime: 120, icon: '🌡️' },
    { name: 'Suspension Repair', description: 'Leaf spring and suspension repair', basePrice: 5999, estimatedTime: 240, icon: '🚛' },
    { name: 'Tire Replacement', description: 'Commercial tire fitting', basePrice: 5999, estimatedTime: 60, icon: '🛞' },
  ],

  'auto-tempo': [
    { name: 'Oil Change', description: 'Engine oil change', basePrice: 399, estimatedTime: 30, icon: '🛢️' },
    { name: 'Tire Puncture Repair', description: 'Three-wheeler tire repair', basePrice: 150, estimatedTime: 20, icon: '🔧' },
    { name: 'Battery Jump Start', description: 'Battery jump start service', basePrice: 249, estimatedTime: 15, icon: '🔋' },
    { name: 'Battery Replacement', description: 'Battery replacement', basePrice: 1999, estimatedTime: 30, icon: '🔋' },
    { name: 'Brake Service', description: 'Brake shoe replacement', basePrice: 599, estimatedTime: 45, icon: '🛑' },
    { name: 'General Service', description: 'Complete auto rickshaw service', basePrice: 999, estimatedTime: 90, icon: '🔧' },
    { name: 'Clutch Repair', description: 'Clutch plate and wire adjustment', basePrice: 699, estimatedTime: 60, icon: '⚙️' },
    { name: 'Silencer Repair', description: 'Exhaust silencer repair/replacement', basePrice: 499, estimatedTime: 45, icon: '💨' },
    { name: 'Meter Calibration', description: 'Fare meter calibration and repair', basePrice: 299, estimatedTime: 30, icon: '📊' },
    { name: 'Roof/Body Repair', description: 'Auto body denting and painting', basePrice: 1499, estimatedTime: 180, icon: '🎨' },
    { name: 'CNG Kit Service', description: 'CNG kit inspection and service', basePrice: 799, estimatedTime: 60, icon: '⛽' },
    { name: 'Tire Replacement', description: 'New tire fitting', basePrice: 999, estimatedTime: 30, icon: '🛞' },
  ],
};

async function seedServices() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    // First, seed categories if they don't exist
    console.log('\n📂 Seeding categories...');
    const defaultCategories = [
      { name: 'Bike/Scooter', slug: 'bike-scooter', icon: '🏍️', description: 'Two-wheeler services' },
      { name: 'Car/Van', slug: 'car-van', icon: '🚗', description: 'Four-wheeler car and van services' },
      { name: 'Truck/Bus', slug: 'truck-bus', icon: '🚛', description: 'Heavy vehicle services' },
      { name: 'Auto/Tempo', slug: 'auto-tempo', icon: '🛺', description: 'Three-wheeler and tempo services' }
    ];

    const categories = {};
    for (const cat of defaultCategories) {
      const category = await ServiceCategory.findOneAndUpdate(
        { slug: cat.slug },
        cat,
        { upsert: true, new: true }
      );
      categories[cat.slug] = category;
      console.log(`  ✅ Category: ${cat.name}`);
    }

    // Now seed services for each category
    console.log('\n🔧 Seeding services...');
    let totalServices = 0;
    let newServices = 0;

    for (const [categorySlug, services] of Object.entries(servicesByCategory)) {
      const category = categories[categorySlug];
      if (!category) {
        console.log(`  ⚠️ Category not found: ${categorySlug}`);
        continue;
      }

      console.log(`\n  📦 ${category.name}:`);

      for (const serviceData of services) {
        totalServices++;
        const slug = createSlug(serviceData.name);
        const vehicleTypes = categoryVehicleTypes[categorySlug] || ['BIKE', 'CAR', 'AUTO', 'TRUCK'];

        try {
          const existingService = await Service.findOne({
            name: serviceData.name,
            categoryId: category._id
          });

          if (existingService) {
            // Update existing service
            await Service.findByIdAndUpdate(existingService._id, {
              ...serviceData,
              slug,
              categoryId: category._id,
              vehicleTypes
            });
            console.log(`    ↻ Updated: ${serviceData.name}`);
          } else {
            // Create new service
            await Service.create({
              ...serviceData,
              slug,
              categoryId: category._id,
              vehicleTypes
            });
            newServices++;
            console.log(`    ✅ Created: ${serviceData.name}`);
          }
        } catch (error) {
          if (error.code === 11000) {
            console.log(`    ⚠️ Duplicate: ${serviceData.name}`);
          } else {
            console.log(`    ❌ Error: ${serviceData.name} - ${error.message}`);
          }
        }
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log(`📊 Summary:`);
    console.log(`   Total services processed: ${totalServices}`);
    console.log(`   New services created: ${newServices}`);
    console.log(`   Services updated: ${totalServices - newServices}`);
    console.log('='.repeat(50));

    console.log('\n✅ Service seeding completed successfully!');

  } catch (error) {
    console.error('❌ Error seeding services:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
    process.exit(0);
  }
}

// Run the seed function
seedServices();
