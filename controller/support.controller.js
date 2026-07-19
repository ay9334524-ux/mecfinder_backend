const SupportQuery = require('../models/SupportQuery');

// Get all queries
const getAllQueries = async (req, res) => {
  try {
    const { status, priority, category, assignedTo } = req.query;
    const filter = {};
    
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;
    if (assignedTo) filter.assignedTo = assignedTo;

    // If support role, only show assigned queries
    if (req.admin?.role === 'SUPPORT') {
      filter.assignedTo = req.admin.id;
    }

    const queries = await SupportQuery.find(filter)
      .populate('userId', 'name email phone')
      .populate('assignedTo', 'name email role')
      .populate('resolvedBy', 'name email')
      .sort({ createdAt: -1 });

    return res.status(200).json({ queries });
  } catch (error) {
    console.error('Error fetching queries:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get single query
const getQueryById = async (req, res) => {
  try {
    const { id } = req.params;

    const query = await SupportQuery.findById(id)
      .populate('userId', 'name email phone')
      .populate('assignedTo', 'name email role')
      .populate('resolvedBy', 'name email');

    if (!query) {
      return res.status(404).json({ message: 'Query not found.' });
    }

    // Support can only view assigned queries
    if (req.admin?.role === 'SUPPORT' && 
        query.assignedTo?._id.toString() !== req.admin.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    return res.status(200).json({ query });
  } catch (error) {
    console.error('Error fetching query:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Create query (for testing - normally from user app)
const createQuery = async (req, res) => {
  try {
    const { userId, subject, message, category, priority, bookingId } = req.body;

    if (!userId || !subject || !message) {
      return res.status(400).json({ message: 'userId, subject, and message are required.' });
    }

    const query = await SupportQuery.create({
      userId,
      subject,
      message,
      category: category || 'OTHER',
      priority: priority || 'MEDIUM',
      bookingId
    });

    const populated = await SupportQuery.findById(query._id)
      .populate('userId', 'name email phone');

    return res.status(201).json({ message: 'Query created successfully.', query: populated });
  } catch (error) {
    console.error('Error creating query:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Update query status
const updateQueryStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolution } = req.body;

    const query = await SupportQuery.findById(id);
    if (!query) {
      return res.status(404).json({ message: 'Query not found.' });
    }

    // Support can only update assigned queries
    if (req.admin?.role === 'SUPPORT' && 
        query.assignedTo?.toString() !== req.admin.id) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    if (status) query.status = status;
    if (resolution) query.resolution = resolution;

    if (status === 'RESOLVED' || status === 'CLOSED') {
      query.resolvedAt = new Date();
      query.resolvedBy = req.admin?.id;
    }

    await query.save();

    const populated = await SupportQuery.findById(query._id)
      .populate('userId', 'name email phone')
      .populate('assignedTo', 'name email role')
      .populate('resolvedBy', 'name email');

    return res.status(200).json({ message: 'Query updated.', query: populated });
  } catch (error) {
    console.error('Error updating query:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Assign query to support staff
const assignQuery = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo } = req.body;

    // Only SUPER_ADMIN and ADMIN can assign
    if (req.admin?.role === 'SUPPORT') {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const query = await SupportQuery.findByIdAndUpdate(
      id,
      { 
        assignedTo,
        status: 'IN_PROGRESS'
      },
      { new: true }
    )
      .populate('userId', 'name email phone')
      .populate('assignedTo', 'name email role');

    if (!query) {
      return res.status(404).json({ message: 'Query not found.' });
    }

    return res.status(200).json({ message: 'Query assigned.', query });
  } catch (error) {
    console.error('Error assigning query:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// Get query stats
const getQueryStats = async (req, res) => {
  try {
    const filter = {};
    
    // Support sees only their stats
    if (req.admin?.role === 'SUPPORT') {
      filter.assignedTo = req.admin.id;
    }

    const [total, open, inProgress, resolved, closed] = await Promise.all([
      SupportQuery.countDocuments(filter),
      SupportQuery.countDocuments({ ...filter, status: 'OPEN' }),
      SupportQuery.countDocuments({ ...filter, status: 'IN_PROGRESS' }),
      SupportQuery.countDocuments({ ...filter, status: 'RESOLVED' }),
      SupportQuery.countDocuments({ ...filter, status: 'CLOSED' })
    ]);

    return res.status(200).json({
      stats: { total, open, inProgress, resolved, closed }
    });
  } catch (error) {
    console.error('Error fetching query stats:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

module.exports = {
  getAllQueries,
  getQueryById,
  createQuery,
  updateQueryStatus,
  assignQuery,
  getQueryStats
};
