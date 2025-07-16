class AppError extends Error {
  constructor({ message, httpStatus = 500, status, isOperational = true }) {
    super(message);

    this.httpStatus = httpStatus;
    this.status = status || (httpStatus >= 400 ? false : true);
    this.isOperational = isOperational;
    this.name = this.constructor.name;

    // Optional: capture stack trace if available
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

export default AppError;
