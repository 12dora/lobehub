/**
 * Thrown when expectedRevision does not match the locked current pointer.
 * Callers (tRPC / services) should map this to a conflict response code.
 */
export class PlatformRevisionConflictError extends Error {
  readonly code = 'PLATFORM_REVISION_CONFLICT' as const;

  constructor(
    message = 'Platform resource revision conflict: expectedRevision does not match current revision',
    public readonly details?: {
      currentRevision?: number;
      expectedRevision?: number;
      resourceId?: string;
      resourceType?: string;
    },
  ) {
    super(message);
    this.name = 'PlatformRevisionConflictError';
  }
}

/**
 * Thrown when code attempts to mutate an already-published (immutable) revision row.
 */
export class PlatformRevisionImmutableError extends Error {
  readonly code = 'PLATFORM_REVISION_IMMUTABLE' as const;

  constructor(message = 'Published platform revisions cannot be modified in place') {
    super(message);
    this.name = 'PlatformRevisionImmutableError';
  }
}
