import { createHash } from 'node:crypto';

import { and, desc, eq, gt, isNull, lte, sql } from 'drizzle-orm';

import { checksumPayload, PlatformRevisionConflictError } from '@/database/models/platform';
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
  type PlatformIdentityProviderDraft,
  type PlatformIdentityProviderType,
} from '@/types/platform/identityProvider';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import { PlatformAuditService } from '../platformAudit';

const SUCCESSFUL_TEST_MAX_AGE_MS = 10 * 60 * 1000;

export interface PublishedIdentityProviderPayload {
  autoProvision: boolean;
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderDraft['claimMapping'];
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
  draft: PlatformIdentityProviderDraft,
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
    failureAuditId: `oidc-idempotency-${digest(`${scopeHash}:${payloadHash}:failure`)}`,
    payloadHash,
    successAuditId: `oidc-idempotency-${scopeHash}`,
  };
};

const toIdempotentResponse = (draft: PlatformIdentityProviderDraft): Record<string, unknown> => {
  const { secret, ...safeDraft } = draft;
  return {
    ...safeDraft,
    fingerprint: secret.fingerprint,
    fingerprintUpdatedAt: secret.updatedAt?.toISOString() ?? null,
    isConfigured: secret.configured,
  };
};

const parseIdempotentResponse = (value: unknown): PlatformIdentityProviderDraft => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  const response = value as Record<string, unknown>;
  const {
    fingerprint,
    fingerprintUpdatedAt: rawFingerprintUpdatedAt,
    isConfigured,
    ...safeDraft
  } = response;
  const fingerprintUpdatedAt =
    typeof rawFingerprintUpdatedAt === 'string'
      ? new Date(rawFingerprintUpdatedAt)
      : rawFingerprintUpdatedAt;
  const parsed = identityProviderDraftSchema.safeParse({
    ...safeDraft,
    secret: {
      configured: isConfigured,
      fingerprint,
      updatedAt: fingerprintUpdatedAt,
    },
  });
  if (!parsed.success) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return parsed.data;
};

const findIdempotentReplay = async (
  tx: Transaction,
  input: {
    action: string;
    actorUserId: string;
    auditId: string;
    payloadHash: string;
    requestId: string;
    targetId: string;
  },
): Promise<PlatformIdentityProviderDraft | null> => {
  const [audit] = await tx
    .select()
    .from(platformAuditLogs)
    .where(eq(platformAuditLogs.id, input.auditId))
    .limit(1);
  if (!audit) return null;
  const afterDiff = audit.afterDiff as Record<string, unknown> | null;
  if (
    audit.action !== input.action ||
    audit.actorUserId !== input.actorUserId ||
    audit.requestId !== input.requestId ||
    audit.result !== 'success' ||
    audit.targetId !== input.targetId ||
    afterDiff?.payloadHash !== input.payloadHash
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT');
  }
  return parseIdempotentResponse(afterDiff.response);
};

const appendFailureAudit = async (
  db: LobeChatDatabase,
  input: {
    action: string;
    actorUserId: string;
    auditId: string;
    error: unknown;
    reason: string;
    requestId: string;
    targetId: string;
  },
) => {
  try {
    const category =
      input.error instanceof IdentityProviderPublicationError
        ? input.error.code.toLowerCase()
        : input.error instanceof PlatformRevisionConflictError
          ? 'revision_conflict'
          : 'identity_provider_publication_failed';
    await new PlatformAuditService(db).append({
      action: input.action,
      actorUserId: input.actorUserId,
      afterDiff: { category },
      id: input.auditId,
      reason: input.reason,
      requestId: input.requestId,
      result: 'failure',
      targetId: input.targetId,
      targetType: 'identity_provider',
    });
  } catch (auditError) {
    console.error('[admin.identityProviders] publication failure audit unavailable', {
      action: input.action,
      errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
    });
  }
};

/** Atomic publication and rollback control plane for restart-activated OIDC providers. */
export class IdentityProviderPublicationService {
  constructor(private readonly db: LobeChatDatabase) {}

  private lockedDraft = async (tx: Transaction, id: string) => {
    const [row] = await tx
      .select()
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, id))
      .for('update');
    if (!row) {
      throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
    }
    const draft: PlatformIdentityProviderDraft = {
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
  ): Promise<PlatformIdentityProviderDraft> => {
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
    try {
      return await this.db.transaction(async (tx) => {
        const { draft, secretRef } = await this.lockedDraft(tx, input.id);
        const replay = await findIdempotentReplay(tx, {
          action,
          actorUserId,
          auditId: idempotency.successAuditId,
          payloadHash: idempotency.payloadHash,
          requestId,
          targetId: input.id,
        });
        if (replay) return replay;
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
        const result: PlatformIdentityProviderDraft = {
          ...draft,
          activationRevision: nextRevision,
          enabled: true,
          revision: nextRevision,
          status: 'pending_restart',
        };
        await new PlatformAuditService(tx).append({
          action,
          actorUserId,
          afterDiff: {
            activation: 'pending_restart',
            checksum,
            payloadHash: idempotency.payloadHash,
            providerKey: payload.providerKey,
            response: toIdempotentResponse(result),
            revision: nextRevision,
            secretFingerprint: payload.secretFingerprint,
          },
          beforeDiff: { revision: draft.revision, status: draft.status },
          configRevision: nextRevision,
          id: idempotency.successAuditId,
          reason,
          requestId,
          result: 'success',
          targetId: input.id,
          targetType: 'identity_provider',
        });
        return result;
      });
    } catch (error) {
      await appendFailureAudit(this.db, {
        action,
        actorUserId,
        auditId: idempotency.failureAuditId,
        error,
        reason,
        requestId,
        targetId: input.id,
      });
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
  ): Promise<PlatformIdentityProviderDraft> => {
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
    try {
      return await this.db.transaction(async (tx) => {
        const { draft } = await this.lockedDraft(tx, input.id);
        const replay = await findIdempotentReplay(tx, {
          action,
          actorUserId,
          auditId: idempotency.successAuditId,
          payloadHash: idempotency.payloadHash,
          requestId,
          targetId: input.id,
        });
        if (replay) return replay;
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
        const result: PlatformIdentityProviderDraft = {
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
        await new PlatformAuditService(tx).append({
          action,
          actorUserId,
          afterDiff: {
            payloadHash: idempotency.payloadHash,
            response: toIdempotentResponse(result),
            restoredFromRevision: input.targetRevision,
            revision: nextRevision,
            status: 'draft',
          },
          beforeDiff: { revision: draft.revision, status: draft.status },
          configRevision: nextRevision,
          id: idempotency.successAuditId,
          reason,
          requestId,
          result: 'success',
          targetId: input.id,
          targetType: 'identity_provider',
        });
        return result;
      });
    } catch (error) {
      await appendFailureAudit(this.db, {
        action,
        actorUserId,
        auditId: idempotency.failureAuditId,
        error,
        reason,
        requestId,
        targetId: input.id,
      });
      throw error;
    }
  };
}
