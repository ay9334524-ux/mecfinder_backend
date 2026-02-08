const Region = require('../models/Region');

// Helper to generate slug
const generateSlug = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
};

// Get all regions
const getAllRegions = async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const regions = await Region.find(filter).sort({ name: 1 });
    return res.status(200).json({ regions });
  } catch (error) {
    console.error('Error fetching regions:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get single region
const getRegionById = async (req, res) => {
  try {
    const { id } = req.params;
    const region = await Region.findById(id);

    if (!region) {
      return res.status(404).json({ message: 'Region not found.' });
    }

    return res.status(200).json({ region });
  } catch (error) {
    console.error('Error fetching region:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Create region
const createRegion = async (req, res) => {
  try {
    const { name, state, country } = req.body;

    if (!name || !state) {
      return res.status(400).json({ message: 'Name and state are required.' });
    }

    const slug = generateSlug(name);

    const region = await Region.create({
      name,
      slug,
      state,
      country: country || 'India',
      createdBy: req.admin?.id
    });

    return res.status(201).json({ message: 'Region created successfully.', region });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Region with this name already exists.' });
    }
    console.error('Error creating region:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Update region
const updateRegion = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, state, country, status } = req.body;

    const updateData = {};
    if (name) {
      updateData.name = name;
      updateData.slug = generateSlug(name);
    }
    if (state) updateData.state = state;
    if (country) updateData.country = country;
    if (status) updateData.status = status;

    const region = await Region.findByIdAndUpdate(id, updateData, { new: true });

    if (!region) {
      return res.status(404).json({ message: 'Region not found.' });
    }

    return res.status(200).json({ message: 'Region updated.', region });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Region with this name already exists.' });
    }
    console.error('Error updating region:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Delete region
const deleteRegion = async (req, res) => {
  try {
    const { id } = req.params;
    const region = await Region.findByIdAndDelete(id);

    if (!region) {
      return res.status(404).json({ message: 'Region not found.' });
    }

    return res.status(200).json({ message: 'Region deleted successfully.' });
  } catch (error) {
    console.error('Error deleting region:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

module.exports = {
  getAllRegions,
  getRegionById,
  createRegion,
  updateRegion,
  deleteRegion
};
