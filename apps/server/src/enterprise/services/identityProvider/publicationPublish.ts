import { and, eq, isNull } from 'drizzle-orm';

import {
  acquireIdentityProviderPublishedRevisionLock,
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
import { selectSuccessfulPublishTest } from './publishTestLookup';

const toPublishedPayload = (
  draft: PlatformIdentityProviderInternalDraft,
): PublishedIdentityProviderPayload & { secretUpdatedAt: string } => {
  if (
    draft.migrationRequired ||
    !draft.issuer ||
    !draft.clientId ||
    !draft.secret.configured ||
    !draft.secret.fingerprint ||
    !draft.secret.updatedAt ||
    draft.usePkce !== true
  ) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  // Distinct from INVALID_SNAPSHOT so the admin UI can say "add an organization first" instead
  // of a generic validation failure. Runtime is fail-closed on an empty allowlist, so a
  // DingTalk provider with none would publish a login method nobody could ever use.
  if (draft.type === 'dingtalk' && draft.dingtalkAllowedCorps.length === 0) {
    throw new IdentityProviderPublicationError(
      'PLATFORM_IDENTITY_PROVIDER_CORP_ALLOWLIST_REQUIRED',
    );
  }
  const payload = {
    autoProvision: draft.autoProvision,
    buttonLabel: draft.buttonLabel,
    claimMapping: draft.claimMapping,
    clientId: draft.clientId,
    dingtalkAllowedCorps: draft.dingtalkAllowedCorps,
    displayName: draft.displayName,
    domainAllowlist: draft.domainAllowlist,
    enabled: true,
    groupRoleMapping: draft.groupRoleMapping,
    icon: draft.icon,
    issuer: draft.issuer,
    providerKey: draft.providerKey,
    scopes: draft.scopes,
    secretFingerprint: draft.secret.fingerprint,
    secretUpdatedAt: draft.secret.updatedAt.toISOString(),
    type: draft.type,
    usePkce: true,
  };
  const parsed = parsePublishedIdentityProviderPayload(payload);
  if (!parsed || typeof parsed.secretUpdatedAt !== 'string') {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
  }
  return { ...parsed, secretUpdatedAt: parsed.secretUpdatedAt };
};

export const commitIdentityProviderPublish = async (
  tx: Transaction,
  {
    fence,
    lockedDraft,
    request,
    testHooks,
  }: {
    fence: IdempotencyOwnerFence;
    lockedDraft: (
      tx: Transaction,
      id: string,
    ) => Promise<{ draft: PlatformIdentityProviderInternalDraft; secretRef: string | null }>;
    request: IdempotencyRequest;
    testHooks: IdentityProviderPublicationTestHooks;
  },
): Promise<PlatformIdentityProviderInternalDraft> => {
  await testHooks.beforePublishedRevisionLock?.(fence);
  await acquireIdentityProviderPublishedRevisionLock(tx);
  await testHooks.afterPublishedRevisionLock?.(fence);
  const { draft, secretRef } = await lockedDraft(tx, request.targetId);
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
  if (draft.status !== 'draft') {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_DRAFT_REQUIRED');
  }
  const payload = toPublishedPayload(draft);
  const [secret] = await tx
    .select({ id: platformIdentityProviderSecrets.id })
    .from(platformIdentityProviderSecrets)
    .where(
      and(
        eq(platformIdentityProviderSecrets.providerId, request.targetId),
        eq(platformIdentityProviderSecrets.ref, secretRef!),
        eq(platformIdentityProviderSecrets.fingerprint, payload.secretFingerprint),
        isNull(platformIdentityProviderSecrets.revokedAt),
      ),
    )
    .limit(1);
  if (!secret) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');
  }
  const successfulTest = await selectSuccessfulPublishTest(tx, {
    id: request.targetId,
    revision: draft.revision,
    secretFingerprint: payload.secretFingerprint,
    secretRef: secretRef!,
  });
  if (!successfulTest) {
    throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_NOT_TESTED');
  }

  const nextRevision = draft.revision + 1;
  const now = new Date();
  const checksum = checksumPayload(payload);
  await tx.insert(platformResourceRevisions).values({
    checksum,
    comment: request.reason,
    createdBy: request.actorUserId,
    payload: payload as unknown as Record<string, unknown>,
    publishedAt: now,
    publishedBy: request.actorUserId,
    resourceId: request.targetId,
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
      updatedBy: request.actorUserId,
    })
    .where(
      and(
        eq(platformIdentityProviders.id, request.targetId),
        eq(platformIdentityProviders.revision, request.expectedRevision),
        eq(platformIdentityProviders.status, 'draft'),
      ),
    )
    .returning();
  if (!updated) throw new PlatformRevisionConflictError();
  const published: PlatformIdentityProviderInternalDraft = {
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
    response: published,
  });
};
