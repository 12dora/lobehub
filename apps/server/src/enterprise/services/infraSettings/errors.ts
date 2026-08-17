export class InfraSettingsSecretRequiredError extends Error {
  readonly field: string;

  constructor(field: string) {
    super(`${field} required when enabling without a stored secret`);
    this.name = 'InfraSettingsSecretRequiredError';
    this.field = field;
  }
}

export class InfraSettingsSecretReuseError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InfraSettingsSecretReuseError';
    this.field = field;
  }
}
