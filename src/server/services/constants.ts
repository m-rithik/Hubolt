// Gateway Configuration
export const GATEWAY_CONFIG = {
  // Timeouts (milliseconds)
  JOB_TIMEOUT_MS: 90000,
  QUEUE_TIMEOUT_MS: 60000,

  // Cache
  MAX_CACHE_SIZE_MB: 100,
  MAX_CACHE_SIZE_BYTES: 100 * 1024 * 1024,
  CACHE_TTL_MS: 3600000, // 1 hour

  // Token estimation
  CHARS_PER_TOKEN: 4,

  // Budget defaults
  DEFAULT_MONTHLY_LIMIT_USD: 1e9, // $1 billion

  // Request
  DEFAULT_REQUEST_TOKENS: 1000,
  DEFAULT_FALLBACK_COST: 0.01,

  // Priority levels
  PRIORITY_SECURITY: 1,
  PRIORITY_STANDARD: 10,

  // Rate limiting
  MAX_REQUESTS_PER_DAY: 1000,
  RATE_LIMIT_WINDOW_RETENTION_DAYS: 7,
};

// Encryption Configuration
export const ENCRYPTION_CONFIG = {
  ALGORITHM: 'aes-256-gcm',
  HASH_ALGORITHM: 'sha256',
  KEY_LENGTH: 32, // 256 bits
  SALT_LENGTH: 16,
  IV_LENGTH: 12, // NIST standard for GCM
  AUTH_TAG_LENGTH: 16,
};

// Valid values
export const VALID_PROVIDERS = ['anthropic', 'openai', 'google'] as const;
export const VALID_SCOPES = ['security', 'standard', 'all'] as const;

// Validation rules
export const VALIDATION_RULES = {
  MIN_API_KEY_LENGTH: 10,
  MIN_PROMPT_LENGTH: 1,
};
