class AppError extends Error {
  constructor({ statusCode = 500, code = 'app_error', message = 'Application error.', details = null }) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

module.exports = AppError;
