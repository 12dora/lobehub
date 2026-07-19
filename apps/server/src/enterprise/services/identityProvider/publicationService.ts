import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import { checksumPayload, PlatformRevisionConflictError } from '@/database/models/platform';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  parsePlatformIdentityProviderClaimMapping,
  type PlatformIdentityProviderDraft,
  type PlatformIdentityProviderType,
} from '@/types/platform/identityProvider';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';

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

const appendFailureAudit = async (
  db: LobeChatDatabase,
  input: { action: string; actorUserId: string; error: unknown; reason: string; targetId: string },
) => {
  try {
    const category =
      input.error instanceof IdentityProviderPublicationError
        ? input.error.code.toLowerCase()
        : input.error instanceof PlatformRevisionConflictError
          ? 'revision_conflict'
          : 'identity_provider_publication_failed';
    await db.insert(platformAuditLogs).values({
      action: input.action,
      actorUserId: input.actorUserId,
      afterDiff: { category },
      reason: input.reason,
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
    input: { expectedRevision: number; id: string; reason: string },
  ): Promise<PlatformIdentityProviderDraft> => {
    const reason = assertReason(input.reason);
    try {
      return await this.db.transaction(async (tx) => {
        const { draft, secretRef } = await this.lockedDraft(tx, input.id);
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
              gt(
                platformIdentityProviderTestAttempts.completedAt,
                new Date(Date.now() - SUCCESSFUL_TEST_MAX_AGE_MS),
              ),
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
        await tx.insert(platformAuditLogs).values({
          action: 'admin.identityProviders.publish',
          actorUserId,
          afterDiff: {
            activation: 'pending_restart',
            checksum,
            providerKey: payload.providerKey,
            revision: nextRevision,
            secretFingerprint: payload.secretFingerprint,
          },
          beforeDiff: { revision: draft.revision, status: draft.status },
          configRevision: nextRevision,
          reason,
          result: 'success',
          targetId: input.id,
          targetType: 'identity_provider',
        });
        return {
          ...draft,
          activationRevision: nextRevision,
          enabled: true,
          revision: nextRevision,
          status: 'pending_restart',
        };
      });
    } catch (error) {
      await appendFailureAudit(this.db, {
        action: 'admin.identityProviders.publish',
        actorUserId,
        error,
        reason,
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
    input: { expectedRevision: number; id: string; reason: string; targetRevision: number },
  ): Promise<PlatformIdentityProviderDraft> => {
    const reason = assertReason(input.reason);
    try {
      return await this.db.transaction(async (tx) => {
        const { draft } = await this.lockedDraft(tx, input.id);
        if (draft.revision !== input.expectedRevision) {
          throw new PlatformRevisionConflictError('Identity provider revision changed', {
            currentRevision: draft.revision,
            expectedRevision: input.expectedRevision,
            resourceId: input.id,
            resourceType: 'oidc',
          });
        }
        const [target] = await tx
          .select({ payload: platformResourceRevisions.payload })
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
        if (!payload) {
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
        await tx.insert(platformAuditLogs).values({
          action: 'admin.identityProviders.rollback',
          actorUserId,
          afterDiff: {
            restoredFromRevision: input.targetRevision,
            revision: nextRevision,
            status: 'draft',
          },
          beforeDiff: { revision: draft.revision, status: draft.status },
          configRevision: nextRevision,
          reason,
          result: 'success',
          targetId: input.id,
          targetType: 'identity_provider',
        });
        return {
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
      });
    } catch (error) {
      await appendFailureAudit(this.db, {
        action: 'admin.identityProviders.rollback',
        actorUserId,
        error,
        reason,
        targetId: input.id,
      });
      throw error;
    }
  };
}
