import { createHash, randomBytes } from 'node:crypto';

import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';

import {
  checksumPayload,
  type PlatformIdentityProviderInternalDraft,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { identityProviderDraftSchema } from '@/server/enterprise/contracts/identityProviders';
import {
  parsePlatformIdentityProviderClaimMapping,
  type PlatformIdentityProviderType,
} from '@/types/platform/identityProvider';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';

const SUCCESSFUL_TEST_MAX_AGE_MS = 10 * 60 * 1000;
const IDEMPOTENCY_LEASE_MS = 5 * 60 * 1000;

export interface PublishedIdentityProviderPayload {
  autoProvision: boolean;
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderInternalDraft['claimMapping'];
  clientId: string;
  displayName: string;
  domainAllowlist: string[];
  enabled: true;
  groupRoleMapping: Record<string, string>;
  icon: string | null;
  issuer: string;
  providerKey: string;
  scopes: string[];
  secretFingerprint: string;
  type: PlatformIdentityProviderType;
  usePkce: true;
}

export class IdentityProviderPublicationError extends Error {
  constructor(
    public readonly code:
      | 'PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT'
      | 'PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT'
      | 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING'
      | 'PLATFORM_IDENTITY_PROVIDER_NOT_FOUND'
      | 'PLATFORM_IDENTITY_PROVIDER_NOT_TESTED'
      | 'PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'IdentityProviderPublicationError';
  }
}

const parseStringArray = (value: unknown, maximum: number): string[] | null => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximum ||
    value.some(
      (item) =>
        typeof item !== 'string' || item.length > 128 || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(item),
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value] as string[];
};

export const parsePublishedIdentityProviderPayload = (
  value: unknown,
): PublishedIdentityProviderPayload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'autoProvision',
    'buttonLabel',
    'claimMapping',
    'clientId',
    'displayName',
    'domainAllowlist',
    'enabled',
    'groupRoleMapping',
    'icon',
    'issuer',
    'providerKey',
    'scopes',
    'secretFingerprint',
    'type',
    'usePkce',
  ]);
  if (Object.keys(row).some((key) => !allowedKeys.has(key))) return null;
  const claimMapping = parsePlatformIdentityProviderClaimMapping(row.claimMapping);
  const scopes = parseStringArray(row.scopes, 32);
  const domainAllowlist =
    Array.isArray(row.domainAllowlist) &&
    row.domainAllowlist.length <= 256 &&
    row.domainAllowlist.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && item.length <= 253 && item === item.trim(),
    )
      ? (row.domainAllowlist as string[])
      : null;
  const groupRoleMapping =
    row.groupRoleMapping &&
    typeof row.groupRoleMapping === 'object' &&
    !Array.isArray(row.groupRoleMapping)
      ? (row.groupRoleMapping as Record<string, unknown>)
      : null;
  if (
    !claimMapping ||
    claimMapping.email.length === 0 ||
    !scopes?.includes('openid') ||
    !domainAllowlist ||
    !groupRoleMapping ||
    Object.keys(groupRoleMapping).length > 1024 ||
    Object.entries(groupRoleMapping).some(
      ([key, item]) =>
        !key || key.length > 256 || typeof item !== 'string' || !item || item.length > 128,
    ) ||
    typeof row.autoProvision !== 'boolean' ||
    typeof row.buttonLabel !== 'string' ||
    !row.buttonLabel.trim() ||
    row.buttonLabel !== row.buttonLabel.trim() ||
    row.buttonLabel.length > 200 ||
    typeof row.clientId !== 'string' ||
    !row.clientId.trim() ||
    row.clientId !== row.clientId.trim() ||
    row.clientId.length > 1000 ||
    typeof row.displayName !== 'string' ||
    !row.displayName.trim() ||
    row.displayName !== row.displayName.trim() ||
    row.displayName.length > 200 ||
    row.enabled !== true ||
    (row.icon !== null && (typeof row.icon !== 'string' || row.icon.length > 4096)) ||
    typeof row.issuer !== 'string' ||
    !row.issuer ||
    row.issuer.length > 4096 ||
    typeof row.providerKey !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(row.providerKey) ||
    typeof row.secretFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.secretFingerprint) ||
    (row.type !== 'authentik' && row.type !== 'generic_oidc') ||
    row.usePkce !== true ||
    containsEnterpriseSecretMaterial({ ...row, secretFingerprint: undefined })
  ) {
    return null;
  }
  try {
    const issuer = new URL(row.issuer);
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      (issuer.port && issuer.port !== '443') ||
      issuer.search ||
      issuer.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return {
    autoProvision: row.autoProvision,
    buttonLabel: row.buttonLabel,
    claimMapping,
    clientId: row.clientId,
    displayName: row.displayName,
    domainAllowlist,
    enabled: true,
    groupRoleMapping: groupRoleMapping as Record<string, string>,
    icon: row.icon as string | null,
    issuer: row.issuer,
    providerKey: row.providerKey,
    scopes,
    secretFingerprint: row.secretFingerprint,
    type: row.type,
    usePkce: true,
  };
};

const toPublishedPayload = (
  draft: PlatformIdentityProviderInternalDraft,
): PublishedIdentityProviderPayload => {
  if (
    draft.migrationRequired ||
    !draft.issuer ||
    !draft.clientId ||
    !draft.secret.configured ||
    !draft.secret.fingerprint ||
    draft.usePkce !== true
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  const payload = {
    autoProvision: draft.autoProvision,
    buttonLabel: draft.buttonLabel,
    claimMapping: draft.claimMapping,
    clientId: draft.clientId,
    displayName: draft.displayName,
    domainAllowlist: draft.domainAllowlist,
    enabled: true,
    groupRoleMapping: draft.groupRoleMapping,
    icon: draft.icon,
    issuer: draft.issuer,
    providerKey: draft.providerKey,
    scopes: draft.scopes,
    secretFingerprint: draft.secret.fingerprint,
    type: draft.type,
    usePkce: true,
  };
  const parsed = parsePublishedIdentityProviderPayload(payload);
  if (!parsed) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  return parsed;
};

const assertReason = (reason: string): string => {
  const normalized = reason.trim();
  if (!normalized || normalized.length > 1000 || containsEnterpriseSecretMaterial(normalized)) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  return normalized;
};

const assertRequestId = (requestId: string): string => {
  const normalized = requestId.toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return normalized;
};

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

const idempotencyContext = (input: {
  action: string;
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

const toIdempotentResponse = (
  draft: PlatformIdentityProviderInternalDraft,
): Record<string, unknown> => {
  const { secret, ...safeDraft } = draft;
  return {
    ...safeDraft,
    isConfigured: secret.configured,
    secretUpdatedAt: secret.updatedAt?.toISOString() ?? null,
  };
};

const parseIdempotentResponse = async (
  tx: Transaction,
  input: IdempotencyRequest,
  afterDiff: Record<string, unknown>,
): Promise<PlatformIdentityProviderInternalDraft> => {
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
  const sourceRevision =
    input.action === 'admin.identityProviders.publish'
      ? afterDiff.revision
      : afterDiff.restoredFromRevision;
  if (!parsed.success || !Number.isInteger(sourceRevision) || Number(sourceRevision) <= 0) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
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
    source.checksum !== checksumPayload(source.payload) ||
    source.secretFingerprint !== payload.secretFingerprint ||
    (legacyFingerprint !== undefined && legacyFingerprint !== payload.secretFingerprint)
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return {
    ...parsed.data,
    secret: { ...parsed.data.secret, fingerprint: payload.secretFingerprint },
  };
};

interface IdempotencyRequest {
  action: string;
  actorUserId: string;
  payloadHash: string;
  reason: string;
  requestId: string;
  reservationAuditId: string;
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
  afterReservation?: (fence: IdempotencyOwnerFence) => Promise<void>;
  leaseMs?: number;
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
    return parseIdempotentResponse(tx, input, afterDiff);
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
    audit.action === `${input.action}.requestReserved`
      ? `${input.action}.requestReserved`
      : `${input.action}.requestLease`;
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
          `${input.action}.requestLease`,
          `${input.action}.requestReserved`,
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

const assertOwnerFence = async (
  tx: Transaction,
  input: IdempotencyRequest,
  fence: IdempotencyOwnerFence,
): Promise<void> => {
  const latest = await findLatestLease(tx, input);
  if (latest.generation !== fence.generation || latest.ownerToken !== fence.ownerToken) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING');
  }
};

const databaseNow = async (tx: Transaction): Promise<Date> => {
  const result = await tx.execute<{ now: Date | string }>(sql`SELECT clock_timestamp() AS now`);
  const value = result.rows[0]?.now;
  const now = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (Number.isNaN(now.getTime())) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return now;
};

const reserveIdempotentRequest = async (
  db: LobeChatDatabase,
  input: IdempotencyRequest,
  leaseMs: number,
): Promise<IdempotencyReservation> => {
  const initialFence = { generation: 1, ownerToken: randomBytes(32).toString('hex') };
  return db.transaction(async (tx) => {
    const initialNow = await databaseNow(tx);
    const initialLeaseExpiresAt = new Date(initialNow.getTime() + leaseMs).toISOString();
    const [inserted] = await tx
      .insert(platformAuditLogs)
      .values({
        action: `${input.action}.requestReserved`,
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
    const recoveryNow = await databaseNow(tx);
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
        action: `${input.action}.requestLease`,
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

const finalizeIdempotentFailure = async (
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

const appendSuccessTerminal = async (
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

/** Atomic publication and rollback control plane for restart-activated OIDC providers. */
export class IdentityProviderPublicationService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly testHooks: IdentityProviderPublicationTestHooks = {},
  ) {}

  /** Minimal secret-free history used to choose an exact rollback target. */
  listPublishedRevisions = async (
    id: string,
  ): Promise<Array<{ publishedAt: Date; revision: number }>> => {
    const rows = await this.db
      .select({
        publishedAt: platformResourceRevisions.publishedAt,
        revision: platformResourceRevisions.revision,
      })
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'oidc'),
          eq(platformResourceRevisions.resourceId, id),
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .orderBy(desc(platformResourceRevisions.revision))
      .limit(50);

    return rows.flatMap((row) =>
      row.publishedAt ? [{ publishedAt: row.publishedAt, revision: row.revision }] : [],
    );
  };

  private lockedDraft = async (tx: Transaction, id: string) => {
    const [row] = await tx
      .select()
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, id))
      .for('update');
    if (!row) {
      throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
    }
    const draft: PlatformIdentityProviderInternalDraft = {
      activationRevision: row.activationRevision,
      autoProvision: row.autoProvision,
      buttonLabel: row.buttonLabel,
      claimMapping:
        parsePlatformIdentityProviderClaimMapping(row.claimMapping) ??
        (() => {
          throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
        })(),
      clientId: row.clientId,
      displayName: row.displayName,
      domainAllowlist: row.domainAllowlist,
      enabled: row.enabled,
      groupRoleMapping: row.groupRoleMapping,
      icon: row.icon,
      id: row.id,
      issuer: row.issuer,
      migrationRequired: row.migrationRequired,
      providerKey: row.providerKey,
      revision: row.revision,
      scopes: row.scopes,
      secret: {
        configured: row.secretRef !== null,
        fingerprint: row.secretFingerprint,
        updatedAt: row.secretUpdatedAt,
      },
      status: row.status,
      type: row.type,
      usePkce: true,
    };
    return { draft, secretRef: row.secretRef };
  };

  publish = async (
    actorUserId: string,
    input: { expectedRevision: number; id: string; reason: string; requestId: string },
  ): Promise<PlatformIdentityProviderInternalDraft> => {
    const reason = assertReason(input.reason);
    const requestId = assertRequestId(input.requestId);
    const action = 'admin.identityProviders.publish';
    const idempotency = idempotencyContext({
      action,
      actorUserId,
      payload: { expectedRevision: input.expectedRevision, id: input.id, reason },
      requestId,
      targetId: input.id,
    });
    const request: IdempotencyRequest = {
      action,
      actorUserId,
      ...idempotency,
      reason,
      requestId,
      targetId: input.id,
    };
    const reservation = await reserveIdempotentRequest(
      this.db,
      request,
      this.testHooks.leaseMs ?? IDEMPOTENCY_LEASE_MS,
    );
    if (reservation.kind === 'replay') return reservation.response;
    const { fence } = reservation;
    await this.testHooks.afterReservation?.(fence);
    try {
      return await this.db.transaction(async (tx) => {
        const { draft, secretRef } = await this.lockedDraft(tx, input.id);
        await this.testHooks.afterDraftLock?.(fence);
        await assertOwnerFence(tx, request, fence);
        if (draft.revision !== input.expectedRevision) {
          throw new PlatformRevisionConflictError('Identity provider revision changed', {
            currentRevision: draft.revision,
            expectedRevision: input.expectedRevision,
            resourceId: input.id,
            resourceType: 'oidc',
          });
        }
        if (draft.status !== 'draft') {
          throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
        }
        const payload = toPublishedPayload(draft);
        const [secret] = await tx
          .select({ id: platformIdentityProviderSecrets.id })
          .from(platformIdentityProviderSecrets)
          .where(
            and(
              eq(platformIdentityProviderSecrets.providerId, input.id),
              eq(platformIdentityProviderSecrets.ref, secretRef!),
              eq(platformIdentityProviderSecrets.fingerprint, payload.secretFingerprint),
              isNull(platformIdentityProviderSecrets.revokedAt),
            ),
          )
          .limit(1);
        if (!secret) {
          throw new IdentityProviderPublicationError(
            'PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE',
          );
        }
        const testCutoff = new Date(Date.now() - SUCCESSFUL_TEST_MAX_AGE_MS);
        const testNow = new Date();
        const [successfulTest] = await tx
          .select({ id: platformIdentityProviderTestAttempts.id })
          .from(platformIdentityProviderTestAttempts)
          .where(
            and(
              eq(platformIdentityProviderTestAttempts.providerId, input.id),
              eq(platformIdentityProviderTestAttempts.providerRevision, draft.revision),
              eq(
                platformIdentityProviderTestAttempts.providerSecretFingerprint,
                payload.secretFingerprint,
              ),
              eq(platformIdentityProviderTestAttempts.providerSecretRef, secretRef!),
              eq(platformIdentityProviderTestAttempts.status, 'succeeded'),
              sql`${platformIdentityProviderTestAttempts.result}->>'valid' = 'true'`,
              gt(platformIdentityProviderTestAttempts.expiresAt, testNow),
              gt(platformIdentityProviderTestAttempts.completedAt, testCutoff),
              lte(platformIdentityProviderTestAttempts.completedAt, testNow),
            ),
          )
          .orderBy(desc(platformIdentityProviderTestAttempts.completedAt))
          .limit(1);
        if (!successfulTest) {
          throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_NOT_TESTED');
        }

        const nextRevision = draft.revision + 1;
        const now = new Date();
        const checksum = checksumPayload(payload);
        await tx.insert(platformResourceRevisions).values({
          checksum,
          comment: reason,
          createdBy: actorUserId,
          payload: payload as unknown as Record<string, unknown>,
          publishedAt: now,
          publishedBy: actorUserId,
          resourceId: input.id,
          resourceType: 'oidc',
          revision: nextRevision,
          secretFingerprint: payload.secretFingerprint,
          status: 'published',
        });
        const [updated] = await tx
          .update(platformIdentityProviders)
          .set({
            activationRevision: nextRevision,
            enabled: true,
            revision: nextRevision,
            status: 'pending_restart',
            updatedAt: now,
            updatedBy: actorUserId,
          })
          .where(
            and(
              eq(platformIdentityProviders.id, input.id),
              eq(platformIdentityProviders.revision, input.expectedRevision),
              eq(platformIdentityProviders.status, 'draft'),
            ),
          )
          .returning();
        if (!updated) throw new PlatformRevisionConflictError();
        const result: PlatformIdentityProviderInternalDraft = {
          ...draft,
          activationRevision: nextRevision,
          enabled: true,
          revision: nextRevision,
          status: 'pending_restart',
        };
        return appendSuccessTerminal(tx, request, fence, {
          afterDiff: {
            activation: 'pending_restart',
            checksum,
            providerKey: payload.providerKey,
            revision: nextRevision,
          },
          beforeDiff: { revision: draft.revision, status: draft.status },
          configRevision: nextRevision,
          response: result,
        });
      });
    } catch (error) {
      if (
        error instanceof IdentityProviderPublicationError &&
        error.code === 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING'
      ) {
        throw error;
      }
      try {
        const replay = await finalizeIdempotentFailure(this.db, request, fence, error);
        if (replay) return replay;
      } catch (auditError) {
        if (
          auditError instanceof IdentityProviderPublicationError &&
          auditError.code === 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING'
        ) {
          throw auditError;
        }
        console.error('[admin.identityProviders] idempotency failure remains pending', {
          action,
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      throw error;
    }
  };

  /**
   * Restore a historical published snapshot as a new draft. The administrator
   * must run the isolated test flow again before publish can create a new head.
   */
  rollback = async (
    actorUserId: string,
    input: {
      expectedRevision: number;
      id: string;
      reason: string;
      requestId: string;
      targetRevision: number;
    },
  ): Promise<PlatformIdentityProviderInternalDraft> => {
    const reason = assertReason(input.reason);
    const requestId = assertRequestId(input.requestId);
    const action = 'admin.identityProviders.rollback';
    const idempotency = idempotencyContext({
      action,
      actorUserId,
      payload: {
        expectedRevision: input.expectedRevision,
        id: input.id,
        reason,
        targetRevision: input.targetRevision,
      },
      requestId,
      targetId: input.id,
    });
    const request: IdempotencyRequest = {
      action,
      actorUserId,
      ...idempotency,
      reason,
      requestId,
      targetId: input.id,
    };
    const reservation = await reserveIdempotentRequest(
      this.db,
      request,
      this.testHooks.leaseMs ?? IDEMPOTENCY_LEASE_MS,
    );
    if (reservation.kind === 'replay') return reservation.response;
    const { fence } = reservation;
    await this.testHooks.afterReservation?.(fence);
    try {
      return await this.db.transaction(async (tx) => {
        const { draft } = await this.lockedDraft(tx, input.id);
        await this.testHooks.afterDraftLock?.(fence);
        await assertOwnerFence(tx, request, fence);
        if (draft.revision !== input.expectedRevision) {
          throw new PlatformRevisionConflictError('Identity provider revision changed', {
            currentRevision: draft.revision,
            expectedRevision: input.expectedRevision,
            resourceId: input.id,
            resourceType: 'oidc',
          });
        }
        const [target] = await tx
          .select({
            checksum: platformResourceRevisions.checksum,
            payload: platformResourceRevisions.payload,
            secretFingerprint: platformResourceRevisions.secretFingerprint,
          })
          .from(platformResourceRevisions)
          .where(
            and(
              eq(platformResourceRevisions.resourceType, 'oidc'),
              eq(platformResourceRevisions.resourceId, input.id),
              eq(platformResourceRevisions.revision, input.targetRevision),
              eq(platformResourceRevisions.status, 'published'),
            ),
          )
          .limit(1);
        const payload = parsePublishedIdentityProviderPayload(target?.payload);
        if (
          !payload ||
          target.checksum !== checksumPayload(target.payload) ||
          target.secretFingerprint !== payload.secretFingerprint
        ) {
          throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
        }
        const [secret] = await tx
          .select({
            createdAt: platformIdentityProviderSecrets.createdAt,
            ref: platformIdentityProviderSecrets.ref,
          })
          .from(platformIdentityProviderSecrets)
          .where(
            and(
              eq(platformIdentityProviderSecrets.providerId, input.id),
              eq(platformIdentityProviderSecrets.fingerprint, payload.secretFingerprint),
              isNull(platformIdentityProviderSecrets.revokedAt),
            ),
          )
          .limit(1);
        if (!secret) {
          throw new IdentityProviderPublicationError(
            'PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE',
          );
        }
        const nextRevision = draft.revision + 1;
        const now = new Date();
        const [updated] = await tx
          .update(platformIdentityProviders)
          .set({
            activationRevision: null,
            autoProvision: payload.autoProvision,
            buttonLabel: payload.buttonLabel,
            claimMapping: payload.claimMapping,
            clientId: payload.clientId,
            displayName: payload.displayName,
            domainAllowlist: payload.domainAllowlist,
            enabled: false,
            groupRoleMapping: payload.groupRoleMapping,
            icon: payload.icon,
            issuer: payload.issuer,
            providerKey: payload.providerKey,
            revision: nextRevision,
            scopes: payload.scopes,
            secretFingerprint: payload.secretFingerprint,
            secretRef: secret.ref,
            secretUpdatedAt: secret.createdAt,
            status: 'draft',
            type: payload.type,
            updatedAt: now,
            updatedBy: actorUserId,
            usePkce: true,
          })
          .where(
            and(
              eq(platformIdentityProviders.id, input.id),
              eq(platformIdentityProviders.revision, input.expectedRevision),
            ),
          )
          .returning();
        if (!updated) throw new PlatformRevisionConflictError();
        const result: PlatformIdentityProviderInternalDraft = {
          ...draft,
          activationRevision: null,
          autoProvision: payload.autoProvision,
          buttonLabel: payload.buttonLabel,
          claimMapping: payload.claimMapping,
          clientId: payload.clientId,
          displayName: payload.displayName,
          domainAllowlist: payload.domainAllowlist,
          enabled: false,
          groupRoleMapping: payload.groupRoleMapping,
          icon: payload.icon,
          issuer: payload.issuer,
          providerKey: payload.providerKey,
          revision: nextRevision,
          scopes: payload.scopes,
          secret: {
            configured: true,
            fingerprint: payload.secretFingerprint,
            updatedAt: secret.createdAt,
          },
          status: 'draft',
          type: payload.type,
          usePkce: true,
        };
        return appendSuccessTerminal(tx, request, fence, {
          afterDiff: {
            restoredFromRevision: input.targetRevision,
            revision: nextRevision,
            status: 'draft',
          },
          beforeDiff: { revision: draft.revision, status: draft.status },
          configRevision: nextRevision,
          response: result,
        });
      });
    } catch (error) {
      if (
        error instanceof IdentityProviderPublicationError &&
        error.code === 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING'
      ) {
        throw error;
      }
      try {
        const replay = await finalizeIdempotentFailure(this.db, request, fence, error);
        if (replay) return replay;
      } catch (auditError) {
        if (
          auditError instanceof IdentityProviderPublicationError &&
          auditError.code === 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING'
        ) {
          throw auditError;
        }
        console.error('[admin.identityProviders] idempotency failure remains pending', {
          action,
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      throw error;
    }
  };
}
