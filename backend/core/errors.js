'use strict';

// A single error shape for every install step / API response.
// The UI shows userMessage + remediation; logs keep detail/cause.
class AppError extends Error {
  constructor(code, userMessage, opts = {}) {
    super(userMessage || code || '操作失败');
    this.name = 'AppError';
    this.code = code || 'E_UNKNOWN';
    this.userMessage = userMessage || '操作失败，请重试';
    this.detail = opts.detail || '';
    this.remediation = opts.remediation || '';
    this.retryable = opts.retryable !== false;
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return {
      code: this.code,
      userMessage: this.userMessage,
      detail: this.detail,
      remediation: this.remediation,
      retryable: this.retryable,
    };
  }
}

function asAppError(err, fallback = {}) {
  if (err instanceof AppError) return err;
  return new AppError(
    fallback.code || 'E_UNKNOWN',
    fallback.userMessage || '操作失败，请重试',
    {
      detail: (err && err.message) || String(err || ''),
      remediation: fallback.remediation || '',
      retryable: fallback.retryable !== false,
      cause: err,
    }
  );
}

module.exports = { AppError, asAppError };
