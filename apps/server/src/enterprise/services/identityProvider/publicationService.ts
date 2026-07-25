import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';

import {
  acquireIdentityProviderPublishedRevisionLock,
  checksumPayload,
  type PlatformIdentityProviderInternalDraft,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import { parsePlatformIdentityProviderClaimMapping } from '@/types/platform/identityProvider';

import { classifyEnterpriseError, observeEnterprisePlatformEvent } from '../../observability';
import { AUDIT_ACTION } from '../audit/auditActionCatalog';
import { disableIdentityProvider, type DisableIdentityProviderResult } from './disableService';
import {
  appendSuccessTerminal,
  assertOwnerFence,
  assertReason,
  assertRequestId,
  finalizeIdempotentFailure,
  IDEMPOTENCY_LEASE_MS,
  idempotencyContext,
  type IdempotencyRequest,
  type IdentityProviderPublicationTestHooks,
  reserveIdempotentRequest,
  runIdempotentOwnerWork,
} from './publicationIdempotency';
import {
  IdentityProviderPublicationError,
  parsePublishedIdentityProviderPayload,
  type PublishedIdentityProviderPayload,
} from './publishedPayload';

export type { DisableIdentityProviderResult } from './disableService';
export type {
  IdempotencyOwnerFence,
  IdentityProviderPublicationTestHooks,
} from './publicationIdempotency';
export {
  IdentityProviderPublicationError,
  parsePublishedIdentityProviderPayload,
  type PublishedIdentityProviderPayload,
} from './publishedPayload';

const SUCCESSFUL_TEST_MAX_AGE_MS = 10 * 60 * 1000;

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

/** Atomic publication and rollback control plane for restart-activated OIDC providers. */
export class IdentityProviderPublicationService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly testHooks: IdentityProviderPublicationTestHooks = {},
  ) {}

  private observePublish = (startedAt: number, error?: unknown): void => {
    const conflict = error instanceof PlatformRevisionConflictError;
    observeEnterprisePlatformEvent({
      domain: 'identity',
      durationMs: Date.now() - startedAt,
      ...(error
        ? {
            errorClass: conflict ? ('ConflictError' as const) : classifyEnterpriseError(error),
          }
        : {}),
      operation: 'publish',
      outcome: error ? (conflict ? 'conflict' : 'failure') : 'success',
      type: 'config_publish',
    });
  };

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
    const startedAt = Date.now();
    const reason = assertReason(input.reason);
    const requestId = assertRequestId(input.requestId);
    const action = AUDIT_ACTION.IDENTITY_PROVIDERS_PUBLISH;
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
      expectedRevision: input.expectedRevision,
      ...idempotency,
      reason,
      requestId,
      targetId: input.id,
    };
    // Reservation is outside the observe try/catch so durable failure/conflict
    // replays thrown from findTerminalReplay are not double-counted in metrics.
    const reservation = await reserveIdempotentRequest(
      this.db,
      request,
      this.testHooks.leaseMs ?? IDEMPOTENCY_LEASE_MS,
      this.testHooks.now,
    );
    if (reservation.kind === 'replay') return reservation.response;
    const { fence } = reservation;
    await this.testHooks.afterReservation?.(fence);
    try {
      const result = await this.db.transaction(async (tx) => {
        await this.testHooks.beforePublishedRevisionLock?.(fence);
        await acquireIdentityProviderPublishedRevisionLock(tx);
        await this.testHooks.afterPublishedRevisionLock?.(fence);
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
          throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_DRAFT_REQUIRED');
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
      });
      this.observePublish(startedAt);
      return result;
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
      this.observePublish(startedAt, error);
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
    const action = AUDIT_ACTION.IDENTITY_PROVIDERS_ROLLBACK;
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
      expectedRevision: input.expectedRevision,
      ...idempotency,
      reason,
      requestId,
      rollbackTargetRevision: input.targetRevision,
      targetId: input.id,
    };
    const outcome = await runIdempotentOwnerWork(
      this.db,
      request,
      {
        afterReservation: this.testHooks.afterReservation,
        leaseMs: this.testHooks.leaseMs ?? IDEMPOTENCY_LEASE_MS,
        now: this.testHooks.now,
      },
      async (tx, fence) => {
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
        const canonicalSecretUpdatedAt =
          typeof payload.secretUpdatedAt === 'string'
            ? new Date(payload.secretUpdatedAt)
            : secret.createdAt;
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
            secretUpdatedAt: canonicalSecretUpdatedAt,
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
            updatedAt: canonicalSecretUpdatedAt,
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
      },
    );
    return outcome.response;
  };
  hasPublishedHistory = async (id: string): Promise<boolean> => {
    const [row] = await this.db
      .select({ revision: platformResourceRevisions.revision })
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'oidc'),
          eq(platformResourceRevisions.resourceId, id),
          eq(platformResourceRevisions.status, 'published'),
        ),
      )
      .limit(1);
    return Boolean(row);
  };

  /**
   * Batch published-history lookup for list pages (one query, not one per draft row).
   * Returns a set of provider ids that have at least one published revision.
   */
  hasPublishedHistoryBatch = async (ids: string[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ resourceId: platformResourceRevisions.resourceId })
      .from(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'oidc'),
          inArray(platformResourceRevisions.resourceId, ids),
          eq(platformResourceRevisions.status, 'published'),
        ),
      );
    return new Set(rows.map((row) => row.resourceId));
  };

  /**
   * Whether a successful safe-login test still satisfies the publish precondition for
   * the provider's current revision (mirrors the NOT_TESTED guard in publish).
   * Uses provider.secretRef (kms handle) — same binding as testStart / publish.
   */
  isPublishTestReady = async (provider: {
    id: string;
    revision: number;
    secretFingerprint: string | null | undefined;
    secretRef: string | null | undefined;
  }): Promise<boolean> => {
    if (!provider.secretFingerprint || !provider.secretRef) return false;

    const testCutoff = new Date(Date.now() - SUCCESSFUL_TEST_MAX_AGE_MS);
    const testNow = new Date();
    const [successfulTest] = await this.db
      .select({ id: platformIdentityProviderTestAttempts.id })
      .from(platformIdentityProviderTestAttempts)
      .where(
        and(
          eq(platformIdentityProviderTestAttempts.providerId, provider.id),
          eq(platformIdentityProviderTestAttempts.providerRevision, provider.revision),
          eq(
            platformIdentityProviderTestAttempts.providerSecretFingerprint,
            provider.secretFingerprint,
          ),
          eq(platformIdentityProviderTestAttempts.providerSecretRef, provider.secretRef),
          eq(platformIdentityProviderTestAttempts.status, 'succeeded'),
          sql`${platformIdentityProviderTestAttempts.result}->>'valid' = 'true'`,
          gt(platformIdentityProviderTestAttempts.expiresAt, testNow),
          gt(platformIdentityProviderTestAttempts.completedAt, testCutoff),
          lte(platformIdentityProviderTestAttempts.completedAt, testNow),
        ),
      )
      .orderBy(desc(platformIdentityProviderTestAttempts.completedAt))
      .limit(1);
    return Boolean(successfulTest);
  };

  /**
   * Batch publish-test readiness for list/get enrichment.
   * Keys are `${id}:${revision}`; values true when a current-revision success exists.
   */
  isPublishTestReadyBatch = async (
    providers: Array<{
      id: string;
      revision: number;
      secretFingerprint: string | null | undefined;
      secretRef: string | null | undefined;
    }>,
  ): Promise<Map<string, boolean>> => {
    const result = new Map<string, boolean>();
    for (const provider of providers) {
      result.set(`${provider.id}:${provider.revision}`, false);
    }
    if (providers.length === 0) return result;

    const providerIds = providers.map((p) => p.id);
    const testCutoff = new Date(Date.now() - SUCCESSFUL_TEST_MAX_AGE_MS);
    const testNow = new Date();
    const attempts = await this.db
      .select({
        providerId: platformIdentityProviderTestAttempts.providerId,
        providerRevision: platformIdentityProviderTestAttempts.providerRevision,
        providerSecretFingerprint: platformIdentityProviderTestAttempts.providerSecretFingerprint,
        providerSecretRef: platformIdentityProviderTestAttempts.providerSecretRef,
      })
      .from(platformIdentityProviderTestAttempts)
      .where(
        and(
          inArray(platformIdentityProviderTestAttempts.providerId, providerIds),
          eq(platformIdentityProviderTestAttempts.status, 'succeeded'),
          sql`${platformIdentityProviderTestAttempts.result}->>'valid' = 'true'`,
          gt(platformIdentityProviderTestAttempts.expiresAt, testNow),
          gt(platformIdentityProviderTestAttempts.completedAt, testCutoff),
          lte(platformIdentityProviderTestAttempts.completedAt, testNow),
        ),
      );

    for (const provider of providers) {
      if (!provider.secretFingerprint || !provider.secretRef) continue;
      const matched = attempts.some(
        (attempt) =>
          attempt.providerId === provider.id &&
          attempt.providerRevision === provider.revision &&
          attempt.providerSecretFingerprint === provider.secretFingerprint &&
          attempt.providerSecretRef === provider.secretRef,
      );
      if (matched) result.set(`${provider.id}:${provider.revision}`, true);
    }
    return result;
  };

  /**
   * Publish a signed tombstone revision (`enabled: false`) and mark the provider disabled.
   * Startup skips tombstones; LKG treats higher-generation removals as monotonic upgrades.
   *
   * Publish HISTORY is determined from the latest published revision row — not mutable
   * draft state. Editing/clearing a secret after publish resets the head to `draft` with
   * `activationRevision=null`, but tombstone must still work whenever ANY published
   * revision exists. Never-published drafts use adminService.delete instead.
   */
  disable = async (
    actorUserId: string,
    input: { expectedRevision: number; id: string; reason: string },
  ): Promise<DisableIdentityProviderResult> =>
    disableIdentityProvider(this.db, actorUserId, input, this.lockedDraft);
}
