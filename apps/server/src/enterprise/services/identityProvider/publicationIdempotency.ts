import { createHash, randomBytes } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  checksumPayload,
  type PlatformIdentityProviderInternalDraft,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { identityProviderDraftSchema } from '@/server/enterprise/contracts/identityProviders';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import {
  AUDIT_ACTION,
  type AuditRequestBaseAction,
  deriveAuditRequestAction,
} from '../audit/auditActionCatalog';
import {
  IdentityProviderPublicationError,
  parsePublishedIdentityProviderPayload,
} from './publishedPayload';

export const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000;

export const assertReason = (reason: string): string => {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 1000 || containsEnterpriseSecretMaterial(normalized)) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  return normalized;
};

export const assertRequestId = (requestId: string): string => {
  const normalized = requestId.toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return normalized;
};

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export const idempotencyContext = (input: {
  action: AuditRequestBaseAction;
  actorUserId: string;
  payload: Record<string, unknown>;
  requestId: string;
  targetId: string;
}) => {
  const scopeHash = digest(
    JSON.stringify({
      action: input.action,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      targetId: input.targetId,
    }),
  );
  const payloadHash = checksumPayload(input.payload);
  return {
    payloadHash,
    reservationAuditId: `oidc-idempotency-${scopeHash}`,
    terminalAuditId: `oidc-idempotency-${digest(`${scopeHash}:terminal`)}`,
  };
};

export const toIdempotentResponse = (
  draft: PlatformIdentityProviderInternalDraft,
): Record<string, unknown> => {
  const { secret, ...safeDraft } = draft;
  return {
    ...safeDraft,
    isConfigured: secret.configured,
    secretUpdatedAt: secret.updatedAt?.toISOString() ?? null,
  };
};

const parseReplayResponse = (afterDiff: Record<string, unknown>) => {
  const value = afterDiff.response;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  const response = value as Record<string, unknown>;
  const {
    fingerprint: legacyFingerprint,
    fingerprintUpdatedAt: legacyFingerprintUpdatedAt,
    isConfigured,
    secretUpdatedAt,
    ...safeDraft
  } = response;
  const rawSecretUpdatedAt = secretUpdatedAt ?? legacyFingerprintUpdatedAt;
  const fingerprintUpdatedAt =
    typeof rawSecretUpdatedAt === 'string' ? new Date(rawSecretUpdatedAt) : rawSecretUpdatedAt;
  const parsed = identityProviderDraftSchema.safeParse({
    ...safeDraft,
    secret: {
      configured: isConfigured,
      updatedAt: fingerprintUpdatedAt,
    },
  });
  return {
    legacyFingerprint,
    legacyFingerprintUpdatedAt,
    parsed,
    secretUpdatedAt,
  };
};

const assertReplayRevisions = (
  input: IdempotencyRequest,
  afterDiff: Record<string, unknown>,
  terminalConfigRevision: number | null,
  parsed: ReturnType<typeof identityProviderDraftSchema.safeParse>,
  secretUpdatedAt: unknown,
  legacyFingerprintUpdatedAt: unknown,
) => {
  const isPublish = input.action === AUDIT_ACTION.IDENTITY_PROVIDERS_PUBLISH;
  const isRollback = input.action === AUDIT_ACTION.IDENTITY_PROVIDERS_ROLLBACK;
  const resultRevision = afterDiff.revision;
  const expectedResultRevision = input.expectedRevision + 1;
  const sourceRevision = isPublish ? resultRevision : input.rollbackTargetRevision;
  if (
    !parsed.success ||
    (!isPublish && !isRollback) ||
    !Number.isInteger(resultRevision) ||
    Number(resultRevision) <= 0 ||
    resultRevision !== expectedResultRevision ||
    !Number.isInteger(sourceRevision) ||
    Number(sourceRevision) <= 0 ||
    terminalConfigRevision !== resultRevision ||
    (secretUpdatedAt !== undefined &&
      legacyFingerprintUpdatedAt !== undefined &&
      secretUpdatedAt !== legacyFingerprintUpdatedAt)
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return { isPublish, isRollback, parsed: parsed.data, resultRevision, sourceRevision };
};

const loadReplaySource = async (
  tx: Transaction,
  input: IdempotencyRequest,
  sourceRevision: unknown,
  isPublish: boolean,
  legacyFingerprint: unknown,
) => {
  const [source] = await tx
    .select({
      checksum: platformResourceRevisions.checksum,
      payload: platformResourceRevisions.payload,
      secretFingerprint: platformResourceRevisions.secretFingerprint,
    })
    .from(platformResourceRevisions)
    .where(
      and(
        eq(platformResourceRevisions.resourceType, 'oidc'),
        eq(platformResourceRevisions.resourceId, input.targetId),
        eq(platformResourceRevisions.revision, Number(sourceRevision)),
        eq(platformResourceRevisions.status, 'published'),
      ),
    )
    .limit(1);
  const payload = parsePublishedIdentityProviderPayload(source?.payload);
  if (
    !payload ||
    (isPublish && typeof payload.secretUpdatedAt !== 'string') ||
    source.checksum !== checksumPayload(source.payload) ||
    source.secretFingerprint !== payload.secretFingerprint ||
    (legacyFingerprint !== undefined && legacyFingerprint !== payload.secretFingerprint)
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  const [secret] = await tx
    .select({
      createdAt: platformIdentityProviderSecrets.createdAt,
      fingerprint: platformIdentityProviderSecrets.fingerprint,
      providerId: platformIdentityProviderSecrets.providerId,
    })
    .from(platformIdentityProviderSecrets)
    .where(
      and(
        eq(platformIdentityProviderSecrets.providerId, input.targetId),
        eq(platformIdentityProviderSecrets.fingerprint, payload.secretFingerprint),
      ),
    )
    .limit(1);
  if (!secret) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return { payload, secret, source };
};

const assertReplayAfterDiff = (
  afterDiff: Record<string, unknown>,
  input: IdempotencyRequest,
  payload: NonNullable<ReturnType<typeof parsePublishedIdentityProviderPayload>>,
  source: { checksum: string },
  isPublish: boolean,
  isRollback: boolean,
) => {
  if (
    (isPublish &&
      (afterDiff.activation !== 'pending_restart' ||
        afterDiff.checksum !== source.checksum ||
        afterDiff.providerKey !== payload.providerKey)) ||
    (isRollback &&
      (afterDiff.restoredFromRevision !== input.rollbackTargetRevision ||
        afterDiff.status !== 'draft'))
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
};

const buildCanonicalReplayDraft = ({
  input,
  isPublish,
  payload,
  resultRevision,
  secret,
}: {
  input: IdempotencyRequest;
  isPublish: boolean;
  payload: NonNullable<ReturnType<typeof parsePublishedIdentityProviderPayload>>;
  resultRevision: unknown;
  secret: { createdAt: Date; fingerprint: string };
}): PlatformIdentityProviderInternalDraft => ({
  activationRevision: isPublish ? Number(resultRevision) : null,
  autoProvision: payload.autoProvision,
  buttonLabel: payload.buttonLabel,
  claimMapping: payload.claimMapping,
  clientId: payload.clientId,
  dingtalkAllowedCorps: payload.dingtalkAllowedCorps,
  displayName: payload.displayName,
  domainAllowlist: payload.domainAllowlist,
  enabled: isPublish,
  groupRoleMapping: payload.groupRoleMapping,
  icon: payload.icon,
  id: input.targetId,
  issuer: payload.issuer,
  migrationRequired: false,
  providerKey: payload.providerKey,
  revision: Number(resultRevision),
  scopes: payload.scopes,
  secret: {
    configured: true,
    fingerprint: secret.fingerprint,
    updatedAt:
      typeof payload.secretUpdatedAt === 'string'
        ? new Date(payload.secretUpdatedAt)
        : secret.createdAt,
  },
  status: isPublish ? 'pending_restart' : 'draft',
  type: payload.type,
  usePkce: true,
});

const reconstructIdempotentResponse = async (
  tx: Transaction,
  input: IdempotencyRequest,
  afterDiff: Record<string, unknown>,
  terminalConfigRevision: number | null,
): Promise<PlatformIdentityProviderInternalDraft> => {
  const { legacyFingerprint, legacyFingerprintUpdatedAt, parsed, secretUpdatedAt } =
    parseReplayResponse(afterDiff);
  const {
    isPublish,
    isRollback,
    parsed: auditDraft,
    resultRevision,
    sourceRevision,
  } = assertReplayRevisions(
    input,
    afterDiff,
    terminalConfigRevision,
    parsed,
    secretUpdatedAt,
    legacyFingerprintUpdatedAt,
  );
  const { payload, secret, source } = await loadReplaySource(
    tx,
    input,
    sourceRevision,
    isPublish,
    legacyFingerprint,
  );
  assertReplayAfterDiff(afterDiff, input, payload, source, isPublish, isRollback);
  const canonical = buildCanonicalReplayDraft({
    input,
    isPublish,
    payload,
    resultRevision,
    secret,
  });
  const normalizedAuditResponse: PlatformIdentityProviderInternalDraft = {
    ...auditDraft,
    secret: { ...auditDraft.secret, fingerprint: payload.secretFingerprint },
  };
  if (
    checksumPayload(toIdempotentResponse(normalizedAuditResponse)) !==
    checksumPayload(toIdempotentResponse(canonical))
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return canonical;
};

export interface IdempotencyRequest {
  action: AuditRequestBaseAction;
  actorUserId: string;
  expectedRevision: number;
  payloadHash: string;
  reason: string;
  requestId: string;
  reservationAuditId: string;
  rollbackTargetRevision?: number;
  targetId: string;
  terminalAuditId: string;
}

export interface IdempotencyOwnerFence {
  generation: number;
  ownerToken: string;
}

interface IdempotencyLease extends IdempotencyOwnerFence {
  leaseExpiresAt: string;
}

type IdempotencyReservation =
  | { fence: IdempotencyOwnerFence; kind: 'owner' }
  | { kind: 'replay'; response: PlatformIdentityProviderInternalDraft };

export interface IdentityProviderPublicationTestHooks {
  afterDraftLock?: (fence: IdempotencyOwnerFence) => Promise<void>;
  afterPublishedRevisionLock?: (fence: IdempotencyOwnerFence) => Promise<void>;
  afterReservation?: (fence: IdempotencyOwnerFence) => Promise<void>;
  /** Fires immediately before acquiring the published-revision advisory lock. */
  beforePublishedRevisionLock?: (fence: IdempotencyOwnerFence) => Promise<void>;
  leaseMs?: number;
  /**
   * Test-only clock for lease issue/expiry. When set, lease timestamps use this
   * instead of `clock_timestamp()` so tests can advance expiry deterministically.
   */
  now?: () => Date;
}

const assertAuditScope = (
  audit: typeof platformAuditLogs.$inferSelect,
  input: IdempotencyRequest,
  action: string,
): Record<string, unknown> => {
  const afterDiff = audit.afterDiff as Record<string, unknown> | null;
  if (
    audit.action !== action ||
    audit.actorUserId !== input.actorUserId ||
    audit.requestId !== input.requestId ||
    audit.targetId !== input.targetId ||
    afterDiff?.payloadHash !== input.payloadHash
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return afterDiff;
};

const findTerminalReplay = async (
  tx: Transaction,
  input: IdempotencyRequest,
): Promise<PlatformIdentityProviderInternalDraft | null> => {
  const [terminal] = await tx
    .select()
    .from(platformAuditLogs)
    .where(eq(platformAuditLogs.id, input.terminalAuditId))
    .limit(1);
  if (!terminal) return null;
  const afterDiff = assertAuditScope(terminal, input, input.action);
  if (terminal.result === 'success' && afterDiff.outcome === 'success') {
    return reconstructIdempotentResponse(tx, input, afterDiff, terminal.configRevision);
  }
  if (
    terminal.result !== 'failure' ||
    afterDiff.outcome !== 'failure' ||
    typeof afterDiff.errorCode !== 'string'
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  if (afterDiff.errorCode === 'PLATFORM_REVISION_CONFLICT') {
    throw new PlatformRevisionConflictError('Identity provider revision changed');
  }
  if (afterDiff.errorCode.startsWith('PLATFORM_IDENTITY_PROVIDER_')) {
    throw new IdentityProviderPublicationError(
      afterDiff.errorCode as IdentityProviderPublicationError['code'],
    );
  }
  throw new Error(afterDiff.errorCode);
};

const lockIdempotencyTarget = async (tx: Transaction, targetId: string): Promise<void> => {
  await tx
    .select({ id: platformIdentityProviders.id })
    .from(platformIdentityProviders)
    .where(eq(platformIdentityProviders.id, targetId))
    .for('update');
};

const parseLease = (
  audit: typeof platformAuditLogs.$inferSelect,
  input: IdempotencyRequest,
): IdempotencyLease => {
  const action =
    audit.action === deriveAuditRequestAction(input.action, 'requestReserved')
      ? deriveAuditRequestAction(input.action, 'requestReserved')
      : deriveAuditRequestAction(input.action, 'requestLease');
  const afterDiff = assertAuditScope(audit, input, action);
  if (
    !Number.isInteger(afterDiff.generation) ||
    Number(afterDiff.generation) <= 0 ||
    typeof afterDiff.ownerToken !== 'string' ||
    !/^[a-f0-9]{64}$/.test(afterDiff.ownerToken) ||
    typeof afterDiff.leaseExpiresAt !== 'string' ||
    Number.isNaN(Date.parse(afterDiff.leaseExpiresAt))
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return {
    generation: Number(afterDiff.generation),
    leaseExpiresAt: afterDiff.leaseExpiresAt,
    ownerToken: afterDiff.ownerToken,
  };
};

const findLatestLease = async (
  tx: Transaction,
  input: IdempotencyRequest,
): Promise<IdempotencyLease> => {
  const audits = await tx
    .select()
    .from(platformAuditLogs)
    .where(
      and(
        inArray(platformAuditLogs.action, [
          deriveAuditRequestAction(input.action, 'requestLease'),
          deriveAuditRequestAction(input.action, 'requestReserved'),
        ]),
        eq(platformAuditLogs.actorUserId, input.actorUserId),
        eq(platformAuditLogs.requestId, input.requestId),
        eq(platformAuditLogs.targetId, input.targetId),
      ),
    );
  if (audits.length === 0) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return audits
    .map((audit) => parseLease(audit, input))
    .reduce((latest, candidate) => (candidate.generation > latest.generation ? candidate : latest));
};

export const assertOwnerFence = async (
  tx: Transaction,
  input: IdempotencyRequest,
  fence: IdempotencyOwnerFence,
): Promise<void> => {
  const latest = await findLatestLease(tx, input);
  if (latest.generation !== fence.generation || latest.ownerToken !== fence.ownerToken) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING');
  }
};

const databaseNow = async (tx: Transaction, nowProvider?: () => Date): Promise<Date> => {
  if (nowProvider) {
    const injected = nowProvider();
    if (Number.isNaN(injected.getTime())) {
      throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
    }
    return injected;
  }
  const result = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
  const value = result.rows[0]?.now;
  const now = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (Number.isNaN(now.getTime())) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return now;
};

export const reserveIdempotentRequest = async (
  db: LobeChatDatabase,
  input: IdempotencyRequest,
  leaseMs: number,
  nowProvider?: () => Date,
): Promise<IdempotencyReservation> => {
  const initialFence = { generation: 1, ownerToken: randomBytes(32).toString('hex') };
  return db.transaction(async (tx) => {
    const initialNow = await databaseNow(tx, nowProvider);
    const initialLeaseExpiresAt = new Date(initialNow.getTime() + leaseMs).toISOString();
    const [inserted] = await tx
      .insert(platformAuditLogs)
      .values({
        action: deriveAuditRequestAction(input.action, 'requestReserved'),
        actorUserId: input.actorUserId,
        afterDiff: {
          ...initialFence,
          leaseExpiresAt: initialLeaseExpiresAt,
          payloadHash: input.payloadHash,
        },
        id: input.reservationAuditId,
        reason: input.reason,
        requestId: input.requestId,
        result: 'success',
        targetId: input.targetId,
        targetType: 'identity_provider',
      })
      .onConflictDoNothing({ target: platformAuditLogs.id })
      .returning({ id: platformAuditLogs.id });
    if (inserted) return { fence: initialFence, kind: 'owner' };

    await lockIdempotencyTarget(tx, input.targetId);
    const replay = await findTerminalReplay(tx, input);
    if (replay) return { kind: 'replay', response: replay };

    const latestLease = await findLatestLease(tx, input);
    const recoveryNow = await databaseNow(tx, nowProvider);
    if (Date.parse(latestLease.leaseExpiresAt) > recoveryNow.getTime()) {
      throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING');
    }

    const recoveredFence = {
      generation: latestLease.generation + 1,
      ownerToken: randomBytes(32).toString('hex'),
    };
    const recoveredLeaseExpiresAt = new Date(recoveryNow.getTime() + leaseMs).toISOString();
    const recoveryId = `oidc-idempotency-${digest(`${input.reservationAuditId}:lease:${recoveredFence.generation}`)}`;
    const [recovered] = await tx
      .insert(platformAuditLogs)
      .values({
        action: deriveAuditRequestAction(input.action, 'requestLease'),
        actorUserId: input.actorUserId,
        afterDiff: {
          ...recoveredFence,
          leaseExpiresAt: recoveredLeaseExpiresAt,
          payloadHash: input.payloadHash,
        },
        id: recoveryId,
        reason: input.reason,
        requestId: input.requestId,
        result: 'success',
        targetId: input.targetId,
        targetType: 'identity_provider',
      })
      .onConflictDoNothing({ target: platformAuditLogs.id })
      .returning({ id: platformAuditLogs.id });
    if (!recovered) {
      throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING');
    }
    return { fence: recoveredFence, kind: 'owner' };
  });
};

const failureCode = (error: unknown): string => {
  if (error instanceof IdentityProviderPublicationError) return error.code;
  if (error instanceof PlatformRevisionConflictError) return 'PLATFORM_REVISION_CONFLICT';
  return 'PLATFORM_IDENTITY_PROVIDER_PUBLICATION_FAILED';
};

export const finalizeIdempotentFailure = async (
  db: LobeChatDatabase,
  input: IdempotencyRequest,
  fence: IdempotencyOwnerFence,
  error: unknown,
): Promise<PlatformIdentityProviderInternalDraft | null> =>
  db.transaction(async (tx) => {
    await lockIdempotencyTarget(tx, input.targetId);
    const replay = await findTerminalReplay(tx, input);
    if (replay) return replay;
    await assertOwnerFence(tx, input, fence);
    const [inserted] = await tx
      .insert(platformAuditLogs)
      .values({
        action: input.action,
        actorUserId: input.actorUserId,
        afterDiff: {
          errorCode: failureCode(error),
          generation: fence.generation,
          outcome: 'failure',
          ownerToken: fence.ownerToken,
          payloadHash: input.payloadHash,
        },
        id: input.terminalAuditId,
        reason: input.reason,
        requestId: input.requestId,
        result: 'failure',
        targetId: input.targetId,
        targetType: 'identity_provider',
      })
      .onConflictDoNothing({ target: platformAuditLogs.id })
      .returning({ id: platformAuditLogs.id });
    if (!inserted) return findTerminalReplay(tx, input);
    return null;
  });

export const appendSuccessTerminal = async (
  tx: Transaction,
  input: IdempotencyRequest,
  fence: IdempotencyOwnerFence,
  values: {
    afterDiff: Record<string, unknown>;
    beforeDiff: Record<string, unknown>;
    configRevision: number;
    response: PlatformIdentityProviderInternalDraft;
  },
): Promise<PlatformIdentityProviderInternalDraft> => {
  await assertOwnerFence(tx, input, fence);
  const [inserted] = await tx
    .insert(platformAuditLogs)
    .values({
      action: input.action,
      actorUserId: input.actorUserId,
      afterDiff: {
        ...values.afterDiff,
        generation: fence.generation,
        outcome: 'success',
        ownerToken: fence.ownerToken,
        payloadHash: input.payloadHash,
        response: toIdempotentResponse(values.response),
      },
      beforeDiff: values.beforeDiff,
      configRevision: values.configRevision,
      id: input.terminalAuditId,
      reason: input.reason,
      requestId: input.requestId,
      result: 'success',
      targetId: input.targetId,
      targetType: 'identity_provider',
    })
    .onConflictDoNothing({ target: platformAuditLogs.id })
    .returning({ id: platformAuditLogs.id });
  if (inserted) return values.response;
  const replay = await findTerminalReplay(tx, input);
  if (!replay) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING');
  }
  return replay;
};

export type IdempotentOwnerWorkResult =
  | { kind: 'owner'; response: PlatformIdentityProviderInternalDraft }
  | { kind: 'replay'; response: PlatformIdentityProviderInternalDraft };

/**
 * Shared publish/rollback shell: reserve lease → run owner work → finalize failure on error.
 * Terminal success is written inside `work` via appendSuccessTerminal.
 * `kind` distinguishes a first-owner commit from an exact request replay (for metrics).
 */
export const runIdempotentOwnerWork = async (
  db: LobeChatDatabase,
  request: IdempotencyRequest,
  options: {
    afterReservation?: (fence: IdempotencyOwnerFence) => Promise<void>;
    leaseMs: number;
    now?: () => Date;
  },
  work: (
    tx: Transaction,
    fence: IdempotencyOwnerFence,
  ) => Promise<PlatformIdentityProviderInternalDraft>,
): Promise<IdempotentOwnerWorkResult> => {
  const reservation = await reserveIdempotentRequest(db, request, options.leaseMs, options.now);
  if (reservation.kind === 'replay') return { kind: 'replay', response: reservation.response };
  const { fence } = reservation;
  await options.afterReservation?.(fence);
  try {
    const response = await db.transaction(async (tx) => work(tx, fence));
    return { kind: 'owner', response };
  } catch (error) {
    if (
      error instanceof IdentityProviderPublicationError &&
      error.code === 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING'
    ) {
      throw error;
    }
    try {
      const replay = await finalizeIdempotentFailure(db, request, fence, error);
      if (replay) return { kind: 'replay', response: replay };
    } catch (auditError) {
      if (
        auditError instanceof IdentityProviderPublicationError &&
        auditError.code === 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING'
      ) {
        throw auditError;
      }
      console.error('[admin.identityProviders] idempotency failure remains pending', {
        action: request.action,
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
    throw error;
  }
};
