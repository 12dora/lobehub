export class PlatformSecretRewrapConflictError extends Error {
  constructor() {
    super('PLATFORM_SECRET_REWRAP_CONFLICT');
    this.name = 'PlatformSecretRewrapConflictError';
  }
}

export class PlatformSecretRewrapInvalidError extends Error {
  constructor() {
    super('PLATFORM_SECRET_REWRAP_INVALID');
    this.name = 'PlatformSecretRewrapInvalidError';
  }
}

export class PlatformSecretRewrapNotFoundError extends Error {
  constructor() {
    super('PLATFORM_SECRET_REWRAP_NOT_FOUND');
    this.name = 'PlatformSecretRewrapNotFoundError';
  }
}

export class PlatformSecretRewrapProviderError extends Error {
  constructor(category: 'active_key_changed' | 'vault_required' | 'vault_unavailable') {
    super(`PLATFORM_SECRET_REWRAP_${category.toUpperCase()}`);
    this.name = 'PlatformSecretRewrapProviderError';
  }
}
