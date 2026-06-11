export class GatewayError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public cause?: unknown
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export class AuthenticationError extends GatewayError {
  constructor(message: string = 'Authentication failed', cause?: unknown) {
    super(message, 401, cause);
    this.name = 'AuthenticationError';
  }
}

export class BudgetExceededError extends GatewayError {
  constructor(public remaining: number = 0, cause?: unknown) {
    super(`Budget limit exceeded. Remaining: $${remaining.toFixed(2)}`, 402, cause);
    this.name = 'BudgetExceededError';
  }
}

export class RateLimitError extends GatewayError {
  constructor(public retryAfterSeconds: number = 60, cause?: unknown) {
    super(`Rate limit exceeded. Retry after ${retryAfterSeconds}s`, 429, cause);
    this.name = 'RateLimitError';
  }
}

export class ConfigurationError extends GatewayError {
  constructor(message: string, statusCode: number = 400, cause?: unknown) {
    super(message, statusCode, cause);
    this.name = 'ConfigurationError';
  }
}

export class ProcessingError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super(message, 500, cause);
    this.name = 'ProcessingError';
  }
}

export function isGatewayError(error: unknown): error is GatewayError {
  return error instanceof GatewayError;
}

export function getErrorStatusCode(error: unknown): number {
  if (isGatewayError(error)) {
    return error.statusCode;
  }
  return 500;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}
