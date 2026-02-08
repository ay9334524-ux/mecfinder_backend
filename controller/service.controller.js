const ServiceCategory = require('../models/ServiceCategory');
const Service = require('../models/Service');

// Helper to generate slug
const generateSlug = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
};

// ==================== CATEGORIES ====================

// Get all categories
const getAllCategories = async (req, res) => {
  try {
    const categories = await ServiceCategory.find().sort({ name: 1 });
    return res.status(200).json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Create category (seed default categories)
const seedCategories = async (req, res) => {
  try {
    const defaultCategories = [
      { name: 'Bike/Scooter', slug: 'bike-scooter', icon: '🏍️', description: 'Two-wheeler services' },
      { name: 'Car/Van', slug: 'car-van', icon: '🚗', description: 'Four-wheeler car and van services' },
      { name: 'Truck/Bus', slug: 'truck-bus', icon: '🚛', description: 'Heavy vehicle services' },
      { name: 'Auto/Tempo', slug: 'auto-tempo', icon: '🛺', description: 'Three-wheeler and tempo services' }
    ];

    for (const cat of defaultCategories) {
      await ServiceCategory.findOneAndUpdate(
        { slug: cat.slug },
        cat,
        { upsert: true, new: true }
      );
    }

    const categories = await ServiceCategory.find();
    return res.status(200).json({ message: 'Categories seeded successfully.', categories });
  } catch (error) {
    console.error('Error seeding categories:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Update category status
const updateCategoryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['ACTIVE', 'INACTIVE'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status.' });
    }

    const category = await ServiceCategory.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    );

    if (!category) {
      return res.status(404).json({ message: 'Category not found.' });
    }

    return res.status(200).json({ message: 'Category updated.', category });
  } catch (error) {
    console.error('Error updating category:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ==================== SERVICES ====================

// Get all services
const getAllServices = async (req, res) => {
  try {
    const { categoryId, status } = req.query;
    const filter = {};
    
    if (categoryId) filter.categoryId = categoryId;
    if (status) filter.status = status;

    const services = await Service.find(filter)
      .populate('categoryId', 'name slug icon')
      .sort({ name: 1 });

    return res.status(200).json({ services });
  } catch (error) {
    console.error('Error fetching services:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get single service
const getServiceById = async (req, res) => {
  try {
    const { id } = req.params;
    const service = await Service.findById(id).populate('categoryId', 'name slug icon');

    if (!service) {
      return res.status(404).json({ message: 'Service not found.' });
    }

    return res.status(200).json({ service });
  } catch (error) {
    console.error('Error fetching service:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Create service
const createService = async (req, res) => {
  try {
    const { name, description, categoryId, basePrice, estimatedTime, icon } = req.body;

    if (!name || !categoryId || basePrice === undefined) {
      return res.status(400).json({ message: 'Name, categoryId, and basePrice are required.' });
    }

    // Verify category exists
    const category = await ServiceCategory.findById(categoryId);
    if (!category) {
      return res.status(404).json({ message: 'Category not found.' });
    }

    const slug = generateSlug(name);

    const service = await Service.create({
      name,
      slug,
      description,
      categoryId,
      basePrice,
      estimatedTime: estimatedTime || 60,
      icon: icon || '🔧',
      createdBy: req.admin?.id
    });

    const populated = await Service.findById(service._id).populate('categoryId', 'name slug icon');

    return res.status(201).json({ message: 'Service created successfully.', service: populated });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Service with this name already exists in this category.' });
    }
    console.error('Error creating service:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Update service
const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, categoryId, basePrice, estimatedTime, icon, status } = req.body;

    const updateData = {};
    if (name) {
      updateData.name = name;
      updateData.slug = generateSlug(name);
    }
    if (description !== undefined) updateData.description = description;
    if (categoryId) updateData.categoryId = categoryId;
    if (basePrice !== undefined) updateData.basePrice = basePrice;
    if (estimatedTime !== undefined) updateData.estimatedTime = estimatedTime;
    if (icon) updateData.icon = icon;
    if (status) updateData.status = status;

    const service = await Service.findByIdAndUpdate(id, updateData, { new: true })
      .populate('categoryId', 'name slug icon');

    if (!service) {
      return res.status(404).json({ message: 'Service not found.' });
    }

    return res.status(200).json({ message: 'Service updated.', service });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Service with this name already exists in this category.' });
    }
    console.error('Error updating service:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Delete service
const deleteService = async (req, res) => {
  try {
    const { id } = req.params;
    const service = await Service.findByIdAndDelete(id);

    if (!service) {
      return res.status(404).json({ message: 'Service not found.' });
    }

    return res.status(200).json({ message: 'Service deleted successfully.' });
  } catch (error) {
    console.error('Error deleting service:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

module.exports = {
  getAllCategories,
  seedCategories,
  updateCategoryStatus,
  getAllServices,
  getServiceById,
  createService,
  updateService,
  deleteService
};
