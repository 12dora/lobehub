/**
 * Error types for platform.audit.retention.v1 worker (SAO-009).
 */

export class AuditRetentionCancelledError extends Error {
  constructor() {
    super('AUDIT_RETENTION_CANCELLED');
    this.name = 'AuditRetentionCancelledError';
  }
}

/** Checkpoint returned null / lease owner changed — do not cancel domain or job. */
export class AuditRetentionLeaseLostError extends Error {
  constructor() {
    super('AUDIT_RETENTION_LEASE_LOST');
    this.name = 'AuditRetentionLeaseLostError';
  }
}

export class AuditRetentionInvalidDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditRetentionInvalidDataError';
  }
}

export const isTerminalContractError = (error: unknown): boolean =>
  error instanceof AuditRetentionInvalidDataError;
