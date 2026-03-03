/**
 * Migration: Convert mechanic lastLocation (flat lat/lng) to GeoJSON location
 * 
 * This script:
 * 1. Finds all mechanics with lastLocation.lat and lastLocation.lng
 * 2. Creates the GeoJSON location.coordinates field [lng, lat]
 * 3. Sets currentBookingId = null and isBusy = false for all mechanics
 * 4. Creates the 2dsphere index on the location field
 * 
 * Run: node scripts/migrate-mechanic-locations.js
 * Safe to run multiple times (idempotent)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Mechanic = require('../models/Mechanic');

const MONGO_URI = process.env.MONGO_URI;

async function migrate() {
  console.log('🔄 Starting mechanic location migration...\n');

  await mongoose.connect(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    family: 4,
  });
  console.log('✅ Connected to MongoDB\n');

  // Step 1: Find mechanics with legacy lat/lng
  const mechanics = await Mechanic.find({
    'lastLocation.lat': { $exists: true, $ne: null },
    'lastLocation.lng': { $exists: true, $ne: null },
  }).select('_id fullName lastLocation location isBusy currentBookingId');

  console.log(`📋 Found ${mechanics.length} mechanics with legacy location data\n`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const mechanic of mechanics) {
    try {
      const lat = mechanic.lastLocation.lat;
      const lng = mechanic.lastLocation.lng;

      // Skip if coordinates are invalid (0,0 or NaN)
      if (!lat || !lng || lat === 0 || lng === 0 || isNaN(lat) || isNaN(lng)) {
        console.log(`  ⏭️ ${mechanic.fullName}: Invalid coords (${lat}, ${lng}), skipping`);
        skipped++;
        continue;
      }

      // Check if GeoJSON already set correctly
      if (mechanic.location?.coordinates?.[0] === lng && 
          mechanic.location?.coordinates?.[1] === lat) {
        console.log(`  ✅ ${mechanic.fullName}: Already migrated`);
        skipped++;
        continue;
      }

      // Update with GeoJSON location
      await Mechanic.findByIdAndUpdate(mechanic._id, {
        $set: {
          'location.type': 'Point',
          'location.coordinates': [lng, lat], // GeoJSON: [longitude, latitude]
        },
      });

      console.log(`  ✅ ${mechanic.fullName}: ${lat}, ${lng} → [${lng}, ${lat}] (GeoJSON)`);
      migrated++;
    } catch (err) {
      console.error(`  ❌ ${mechanic.fullName}: Error - ${err.message}`);
      errors++;
    }
  }

  // Step 2: Reset busy state for all mechanics (clean slate)
  console.log('\n🔄 Resetting busy state for all mechanics...');
  const resetResult = await Mechanic.updateMany(
    {},
    { $set: { currentBookingId: null } }
  );
  console.log(`  ✅ Reset currentBookingId for ${resetResult.modifiedCount} mechanics`);

  // Step 3: Ensure 2dsphere index exists
  console.log('\n🔄 Ensuring 2dsphere index...');
  try {
    await Mechanic.collection.createIndex(
      { location: '2dsphere' },
      { background: true, name: 'location_2dsphere' }
    );
    console.log('  ✅ 2dsphere index created/confirmed on location field');
  } catch (indexErr) {
    if (indexErr.code === 85 || indexErr.code === 86) {
      console.log('  ℹ️ 2dsphere index already exists');
    } else {
      console.error('  ❌ Index creation error:', indexErr.message);
    }
  }

  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log('📊 Migration Summary:');
  console.log(`   Total mechanics: ${mechanics.length}`);
  console.log(`   Migrated: ${migrated}`);
  console.log(`   Skipped: ${skipped}`);
  console.log(`   Errors: ${errors}`);
  console.log('═'.repeat(50));

  // Test: verify $nearSphere works
  console.log('\n🧪 Testing $nearSphere query...');
  try {
    const testResults = await Mechanic.find({
      location: {
        $nearSphere: {
          $geometry: {
            type: 'Point',
            coordinates: [85.1376, 25.6093], // Patna coordinates
          },
          $maxDistance: 50000, // 50km in meters
        },
      },
    }).select('fullName location lastLocation').limit(5);

    console.log(`  ✅ $nearSphere query returned ${testResults.length} results`);
    testResults.forEach(m => {
      console.log(`     - ${m.fullName}: [${m.location?.coordinates?.join(', ')}]`);
    });
  } catch (testErr) {
    console.log(`  ⚠️ $nearSphere test failed: ${testErr.message}`);
    console.log('  This might mean no mechanics have valid coordinates yet.');
  }

  await mongoose.disconnect();
  console.log('\n✅ Migration complete!');
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
