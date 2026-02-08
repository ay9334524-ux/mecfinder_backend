const RegionPricing = require('../models/RegionPricing');
const Service = require('../models/Service');
const Region = require('../models/Region');

// Get all pricing entries
const getAllPricing = async (req, res) => {
  try {
    const { serviceId, regionId, status } = req.query;
    const filter = {};
    
    if (serviceId) filter.serviceId = serviceId;
    if (regionId) filter.regionId = regionId;
    if (status) filter.status = status;

    const pricing = await RegionPricing.find(filter)
      .populate('serviceId', 'name slug basePrice categoryId')
      .populate('regionId', 'name slug state')
      .populate({
        path: 'serviceId',
        populate: { path: 'categoryId', select: 'name icon' }
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({ pricing });
  } catch (error) {
    console.error('Error fetching pricing:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get pricing by region
const getPricingByRegion = async (req, res) => {
  try {
    const { regionId } = req.params;

    const pricing = await RegionPricing.find({ regionId })
      .populate('serviceId', 'name slug basePrice categoryId')
      .populate({
        path: 'serviceId',
        populate: { path: 'categoryId', select: 'name icon' }
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({ pricing });
  } catch (error) {
    console.error('Error fetching pricing by region:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get pricing by service
const getPricingByService = async (req, res) => {
  try {
    const { serviceId } = req.params;

    const pricing = await RegionPricing.find({ serviceId })
      .populate('regionId', 'name slug state')
      .sort({ createdAt: -1 });

    return res.status(200).json({ pricing });
  } catch (error) {
    console.error('Error fetching pricing by service:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get single pricing entry
const getPricingById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const pricing = await RegionPricing.findById(id)
      .populate('serviceId', 'name slug basePrice categoryId')
      .populate('regionId', 'name slug state')
      .populate({
        path: 'serviceId',
        populate: { path: 'categoryId', select: 'name icon' }
      });

    if (!pricing) {
      return res.status(404).json({ message: 'Pricing entry not found.' });
    }

    return res.status(200).json({ pricing });
  } catch (error) {
    console.error('Error fetching pricing:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Create or update pricing
const upsertPricing = async (req, res) => {
  try {
    const { serviceId, regionId, basePrice, gstPercent, platformFeePercent, travelCharge } = req.body;

    if (!serviceId || !regionId || basePrice === undefined) {
      return res.status(400).json({ message: 'serviceId, regionId, and basePrice are required.' });
    }

    // Verify service exists
    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ message: 'Service not found.' });
    }

    // Verify region exists
    const region = await Region.findById(regionId);
    if (!region) {
      return res.status(404).json({ message: 'Region not found.' });
    }

    const gst = gstPercent ?? 18;
    const platformFee = platformFeePercent ?? 25;
    const travel = travelCharge ?? 88;

    // Calculate amounts manually
    const gstAmount = Math.round((basePrice * gst) / 100);
    const platformFeeAmount = Math.round((basePrice * platformFee) / 100);
    const totalPrice = basePrice + gstAmount + platformFeeAmount + travel;
    const mechanicEarning = basePrice + travel;
    const companyEarning = gstAmount + platformFeeAmount;

    const pricingData = {
      serviceId,
      regionId,
      basePrice,
      gstPercent: gst,
      gstAmount,
      platformFeePercent: platformFee,
      platformFeeAmount,
      travelCharge: travel,
      totalPrice,
      mechanicEarning,
      companyEarning,
      createdBy: req.admin?.id
    };

    // Upsert: update if exists, create if not
    const pricing = await RegionPricing.findOneAndUpdate(
      { serviceId, regionId },
      pricingData,
      { new: true, upsert: true, runValidators: true }
    );

    const populated = await RegionPricing.findById(pricing._id)
      .populate('serviceId', 'name slug basePrice')
      .populate('regionId', 'name slug state');

    return res.status(200).json({ 
      message: 'Pricing saved successfully.', 
      pricing: populated 
    });
  } catch (error) {
    console.error('Error saving pricing:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Update pricing
const updatePricing = async (req, res) => {
  try {
    const { id } = req.params;
    const { basePrice, gstPercent, platformFeePercent, travelCharge, status } = req.body;

    const pricing = await RegionPricing.findById(id);
    if (!pricing) {
      return res.status(404).json({ message: 'Pricing entry not found.' });
    }

    if (basePrice !== undefined) pricing.basePrice = basePrice;
    if (gstPercent !== undefined) pricing.gstPercent = gstPercent;
    if (platformFeePercent !== undefined) pricing.platformFeePercent = platformFeePercent;
    if (travelCharge !== undefined) pricing.travelCharge = travelCharge;
    if (status) pricing.status = status;

    // Recalculate amounts
    pricing.gstAmount = Math.round((pricing.basePrice * pricing.gstPercent) / 100);
    pricing.platformFeeAmount = Math.round((pricing.basePrice * pricing.platformFeePercent) / 100);
    pricing.totalPrice = pricing.basePrice + pricing.gstAmount + pricing.platformFeeAmount + pricing.travelCharge;
    pricing.mechanicEarning = pricing.basePrice + pricing.travelCharge;
    pricing.companyEarning = pricing.gstAmount + pricing.platformFeeAmount;

    await pricing.save();

    const populated = await RegionPricing.findById(pricing._id)
      .populate('serviceId', 'name slug basePrice')
      .populate('regionId', 'name slug state');

    return res.status(200).json({ message: 'Pricing updated.', pricing: populated });
  } catch (error) {
    console.error('Error updating pricing:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Delete pricing
const deletePricing = async (req, res) => {
  try {
    const { id } = req.params;
    const pricing = await RegionPricing.findByIdAndDelete(id);

    if (!pricing) {
      return res.status(404).json({ message: 'Pricing entry not found.' });
    }

    return res.status(200).json({ message: 'Pricing deleted successfully.' });
  } catch (error) {
    console.error('Error deleting pricing:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Calculate pricing preview (without saving)
const calculatePricing = async (req, res) => {
  try {
    const { basePrice, gstPercent = 18, platformFeePercent = 25, travelCharge = 88 } = req.body;

    if (basePrice === undefined) {
      return res.status(400).json({ message: 'basePrice is required.' });
    }

    const gstAmount = Math.round((basePrice * gstPercent) / 100);
    const platformFeeAmount = Math.round((basePrice * platformFeePercent) / 100);
    const totalPrice = basePrice + gstAmount + platformFeeAmount + travelCharge;
    const mechanicEarning = basePrice + travelCharge;
    const companyEarning = gstAmount + platformFeeAmount;

    return res.status(200).json({
      breakdown: {
        basePrice,
        gstPercent,
        gstAmount,
        platformFeePercent,
        platformFeeAmount,
        travelCharge,
        totalPrice,
        mechanicEarning,
        companyEarning
      }
    });
  } catch (error) {
    console.error('Error calculating pricing:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

module.exports = {
  getAllPricing,
  getPricingByRegion,
  getPricingByService,
  getPricingById,
  upsertPricing,
  updatePricing,
  deletePricing,
  calculatePricing
};
