import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  type PlatformIdentityProviderInternalDraft,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import {
  platformIdentityProviders,
  platformIdentityProviderTestAttempts,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  parseDingTalkAllowedCorps,
  parsePlatformIdentityProviderClaimMapping,
} from '@/types/platform/identityProvider';

import { classifyEnterpriseError, observeEnterprisePlatformEvent } from '../../observability';
import { AUDIT_ACTION } from '../audit/auditActionCatalog';
import { disableIdentityProvider, type DisableIdentityProviderResult } from './disableService';
import {
  assertReason,
  assertRequestId,
  IDEMPOTENCY_LEASE_MS,
  idempotencyContext,
  type IdempotencyRequest,
  type IdentityProviderPublicationTestHooks,
  runIdempotentOwnerWork,
} from './publicationIdempotency';
import { commitIdentityProviderPublish } from './publicationPublish';
import { commitIdentityProviderRollback } from './publicationRollback';
import { IdentityProviderPublicationError } from './publishedPayload';
import {
  selectSuccessfulPublishTest,
  SUCCESSFUL_TEST_MAX_AGE_MS,
  successfulTestWhere,
} from './publishTestLookup';

export type { DisableIdentityProviderResult } from './disableService';
export type {
  IdempotencyOwnerFence,
  IdentityProviderPublicationTestHooks,
} from './publicationIdempotency';
export { restoredConfigFromPublishedPayload } from './publicationRollback';
export {
  IdentityProviderPublicationError,
  parsePublishedIdentityProviderPayload,
  type PublishedIdentityProviderPayload,
} from './publishedPayload';

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
      dingtalkAllowedCorps:
        parseDingTalkAllowedCorps(row.dingtalkAllowedCorps ?? []) ??
        (() => {
          throw new IdentityProviderPublicationError('PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT');
        })(),
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
    // Reservation-time replays (success or durable failure/conflict) must not be
    // observed. afterReservation only runs after this caller becomes owner.
    let ownerReserved = false;
    try {
      const outcome = await runIdempotentOwnerWork(
        this.db,
        request,
        {
          afterReservation: async (fence) => {
            await this.testHooks.afterReservation?.(fence);
            ownerReserved = true;
          },
          leaseMs: this.testHooks.leaseMs ?? IDEMPOTENCY_LEASE_MS,
          now: this.testHooks.now,
        },
        async (tx, fence) =>
          commitIdentityProviderPublish(tx, {
            fence,
            lockedDraft: this.lockedDraft,
            request,
            testHooks: this.testHooks,
          }),
      );
      if (outcome.kind === 'owner') {
        this.observePublish(startedAt);
      }
      return outcome.response;
    } catch (error) {
      if (
        !ownerReserved ||
        (error instanceof IdentityProviderPublicationError &&
          error.code === 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING')
      ) {
        throw error;
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
      async (tx, fence) =>
        commitIdentityProviderRollback(tx, {
          fence,
          lockedDraft: this.lockedDraft,
          request,
          targetRevision: input.targetRevision,
          testHooks: this.testHooks,
        }),
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

    const successfulTest = await selectSuccessfulPublishTest(this.db, {
      id: provider.id,
      revision: provider.revision,
      secretFingerprint: provider.secretFingerprint,
      secretRef: provider.secretRef,
    });
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
          successfulTestWhere(testNow, testCutoff),
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
