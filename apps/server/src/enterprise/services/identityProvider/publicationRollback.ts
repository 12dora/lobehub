import { and, eq, isNull } from 'drizzle-orm';

import {
  checksumPayload,
  type PlatformIdentityProviderInternalDraft,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import {
  appendSuccessTerminal,
  assertOwnerFence,
  type IdempotencyOwnerFence,
  type IdempotencyRequest,
  type IdentityProviderPublicationTestHooks,
} from './publicationIdempotency';
import {
  IdentityProviderPublicationError,
  parsePublishedIdentityProviderPayload,
  type PublishedIdentityProviderPayload,
} from './publishedPayload';

/**
 * Every configuration field a rollback restores from the target published revision.
 *
 * Derived from the payload by construction (rather than field-by-field at the call site) so a
 * new published field cannot be silently left at the *current draft's* value — that bug let a
 * rollback preserve a revoked DingTalk organisation grant.
 */
export const restoredConfigFromPublishedPayload = (
  payload: PublishedIdentityProviderPayload,
): Pick<
  PublishedIdentityProviderPayload,
  | 'autoProvision'
  | 'buttonLabel'
  | 'claimMapping'
  | 'clientId'
  | 'dingtalkAllowedCorps'
  | 'displayName'
  | 'domainAllowlist'
  | 'groupRoleMapping'
  | 'icon'
  | 'issuer'
  | 'providerKey'
  | 'scopes'
  | 'secretFingerprint'
  | 'type'
> => {
  // `enabled` is decided by the caller (rollback always forks back to a disabled draft) and the
  // secret timestamps come from the stored secret version, so both are excluded here.
  const { enabled: _enabled, secretUpdatedAt: _secretUpdatedAt, ...config } = payload;
  return config;
};

export const commitIdentityProviderRollback = async (
  tx: Transaction,
  {
    fence,
    lockedDraft,
    request,
    targetRevision,
    testHooks,
  }: {
    fence: IdempotencyOwnerFence;
    lockedDraft: (
      tx: Transaction,
      id: string,
    ) => Promise<{ draft: PlatformIdentityProviderInternalDraft; secretRef: string | null }>;
    request: IdempotencyRequest;
    targetRevision: number;
    testHooks: IdentityProviderPublicationTestHooks;
  },
): Promise<PlatformIdentityProviderInternalDraft> => {
  const { draft } = await lockedDraft(tx, request.targetId);
  await testHooks.afterDraftLock?.(fence);
  await assertOwnerFence(tx, request, fence);
  if (draft.revision !== request.expectedRevision) {
    throw new PlatformRevisionConflictError('Identity provider revision changed', {
      currentRevision: draft.revision,
      expectedRevision: request.expectedRevision,
      resourceId: request.targetId,
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
        eq(platformResourceRevisions.resourceId, request.targetId),
        eq(platformResourceRevisions.revision, targetRevision),
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
        eq(platformIdentityProviderSecrets.providerId, request.targetId),
        eq(platformIdentityProviderSecrets.fingerprint, payload.secretFingerprint),
        isNull(platformIdentityProviderSecrets.revokedAt),
      ),
    )
    .limit(1);
  if (!secret) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');
  }
  const canonicalSecretUpdatedAt =
    typeof payload.secretUpdatedAt === 'string'
      ? new Date(payload.secretUpdatedAt)
      : secret.createdAt;
  const nextRevision = draft.revision + 1;
  const now = new Date();
  const restored = restoredConfigFromPublishedPayload(payload);
  const [updated] = await tx
    .update(platformIdentityProviders)
    .set({
      ...restored,
      activationRevision: null,
      enabled: false,
      revision: nextRevision,
      secretRef: secret.ref,
      secretUpdatedAt: canonicalSecretUpdatedAt,
      status: 'draft',
      updatedAt: now,
      updatedBy: request.actorUserId,
      usePkce: true,
    })
    .where(
      and(
        eq(platformIdentityProviders.id, request.targetId),
        eq(platformIdentityProviders.revision, request.expectedRevision),
      ),
    )
    .returning();
  if (!updated) throw new PlatformRevisionConflictError();
  const { secretFingerprint, ...restoredDraftFields } = restored;
  const result: PlatformIdentityProviderInternalDraft = {
    ...draft,
    ...restoredDraftFields,
    activationRevision: null,
    enabled: false,
    revision: nextRevision,
    secret: {
      configured: true,
      fingerprint: secretFingerprint,
      updatedAt: canonicalSecretUpdatedAt,
    },
    status: 'draft',
    usePkce: true,
  };
  return appendSuccessTerminal(tx, request, fence, {
    afterDiff: {
      restoredFromRevision: targetRevision,
      revision: nextRevision,
      status: 'draft',
    },
    beforeDiff: { revision: draft.revision, status: draft.status },
    configRevision: nextRevision,
    response: result,
  });
};
