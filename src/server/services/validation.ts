export class ValidationError extends Error {
  constructor(public field: string, public reason: string) {
    super(`Validation failed for ${field}: ${reason}`);
    this.name = 'ValidationError';
  }
}

export class InputValidator {
  validateOrgId(orgId: string): void {
    if (!orgId || typeof orgId !== 'string' || orgId.trim().length === 0) {
      throw new ValidationError('orgId', 'must be a non-empty string');
    }
  }

  validateProvider(provider: string): void {
    const validProviders = ['anthropic', 'openai', 'google'];
    if (!provider || !validProviders.includes(provider)) {
      throw new ValidationError('provider', `must be one of: ${validProviders.join(', ')}`);
    }
  }

  validateApiKey(apiKey: string): void {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      throw new ValidationError('apiKey', 'must be a non-empty string with at least 10 characters');
    }
  }

  validateCost(cost: number): void {
    if (typeof cost !== 'number' || cost < 0 || !isFinite(cost)) {
      throw new ValidationError('cost', 'must be a non-negative finite number');
    }
  }

  validateTokens(tokens: number): void {
    if (typeof tokens !== 'number' || tokens < 0 || !Number.isInteger(tokens)) {
      throw new ValidationError('tokens', 'must be a non-negative integer');
    }
  }

  validatePrompt(prompt: string, minLength: number = 1): void {
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < minLength) {
      throw new ValidationError('prompt', `must be a non-empty string with at least ${minLength} characters`);
    }
  }

  validateRequestScope(scope: string): void {
    const validScopes = ['security', 'standard', 'all'];
    if (!scope || !validScopes.includes(scope)) {
      throw new ValidationError('scope', `must be one of: ${validScopes.join(', ')}`);
    }
  }
}
