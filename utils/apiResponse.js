/**
 * Standardized API Response Utility
 * Ensures consistent response format across all endpoints
 */

class ApiResponse {
  /**
   * Success response
   * @param {Object} res - Express response object
   * @param {Object} data - Response data
   * @param {String} message - Success message
   * @param {Number} statusCode - HTTP status code
   */
  static success(res, data = null, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Created response (201)
   */
  static created(res, data = null, message = 'Created successfully') {
    return this.success(res, data, message, 201);
  }

  /**
   * Error response
   * @param {Object} res - Express response object
   * @param {String} message - Error message
   * @param {Number} statusCode - HTTP status code
   * @param {Object} errors - Additional error details
   */
  static error(res, message = 'Something went wrong', statusCode = 500, errors = null) {
    const response = {
      success: false,
      message,
      timestamp: new Date().toISOString(),
    };
    
    if (errors) {
      response.errors = errors;
    }
    
    return res.status(statusCode).json(response);
  }

  /**
   * Bad Request (400)
   */
  static badRequest(res, message = 'Bad request', errors = null) {
    return this.error(res, message, 400, errors);
  }

  /**
   * Unauthorized (401)
   */
  static unauthorized(res, message = 'Unauthorized') {
    return this.error(res, message, 401);
  }

  /**
   * Forbidden (403)
   */
  static forbidden(res, message = 'Access forbidden') {
    return this.error(res, message, 403);
  }

  /**
   * Not Found (404)
   */
  static notFound(res, message = 'Resource not found') {
    return this.error(res, message, 404);
  }

  /**
   * Conflict (409)
   */
  static conflict(res, message = 'Resource already exists') {
    return this.error(res, message, 409);
  }

  /**
   * Validation Error (422)
   */
  static validationError(res, errors, message = 'Validation failed') {
    return this.error(res, message, 422, errors);
  }

  /**
   * Too Many Requests (429)
   */
  static tooManyRequests(res, message = 'Too many requests, please try again later') {
    return this.error(res, message, 429);
  }

  /**
   * Internal Server Error (500)
   */
  static serverError(res, message = 'Internal server error') {
    return this.error(res, message, 500);
  }

  /**
   * Paginated response
   * @param {Object} res - Express response object
   * @param {Array} data - Array of items
   * @param {Object} pagination - Pagination info
   * @param {String} message - Success message
   */
  static paginated(res, data, pagination, message = 'Success') {
    return res.status(200).json({
      success: true,
      message,
      data,
      pagination: {
        currentPage: pagination.page,
        totalPages: Math.ceil(pagination.total / pagination.limit),
        totalItems: pagination.total,
        itemsPerPage: pagination.limit,
        hasNextPage: pagination.page < Math.ceil(pagination.total / pagination.limit),
        hasPrevPage: pagination.page > 1,
      },
      timestamp: new Date().toISOString(),
    });
  }
}

module.exports = ApiResponse;
