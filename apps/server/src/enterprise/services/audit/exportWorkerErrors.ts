/**
 * Audit export worker error types (SAO-009).
 */
/** Explicit domain/job cancellation only — never lease loss. */
export class AuditExportCancelledError extends Error {
  constructor() {
    super('AUDIT_EXPORT_CANCELLED');
    this.name = 'AuditExportCancelledError';
  }
}

/** Checkpoint returned null / lease owner changed — do not cancel domain or job. */
export class AuditExportLeaseLostError extends Error {
  constructor() {
    super('AUDIT_EXPORT_LEASE_LOST');
    this.name = 'AuditExportLeaseLostError';
  }
}

/** Terminal contract error: export exceeds frozen maxExportRows. */
export class AuditExportMaxRowsError extends Error {
  constructor(public readonly maxExportRows: number) {
    super('AUDIT_EXPORT_MAX_ROWS_EXCEEDED');
    this.name = 'AuditExportMaxRowsError';
  }
}

/** Terminal contract error: frozen filter snapshot is invalid for the export kind. */
export class AuditExportInvalidFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditExportInvalidFilterError';
  }
}

/** Terminal: streamed artifact exceeds the hard byte cap (F10). */
export class AuditExportArtifactTooLargeError extends Error {
  constructor() {
    super('AUDIT_EXPORT_ARTIFACT_TOO_LARGE');
    this.name = 'AuditExportArtifactTooLargeError';
  }
}

export const isTerminalContractError = (error: unknown): boolean =>
  error instanceof AuditExportMaxRowsError ||
  error instanceof AuditExportInvalidFilterError ||
  error instanceof AuditExportArtifactTooLargeError;
