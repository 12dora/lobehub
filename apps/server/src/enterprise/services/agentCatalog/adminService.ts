import debug from 'debug';

import {
  acquirePlatformAgentReferenceLock,
  type PlatformAgentAssignmentSafeItem,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import type { PlatformAgentItem } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminPlatformAgentArchiveInput,
  AdminPlatformAgentAssignmentListInput,
  AdminPlatformAgentAssignmentPreviewInput,
  AdminPlatformAgentAssignmentRemoveInput,
  AdminPlatformAgentAssignmentUpsertInput,
  AdminPlatformAgentCreateInput,
  AdminPlatformAgentDeleteInput,
  AdminPlatformAgentDependentsInput,
  AdminPlatformAgentListInput,
  AdminPlatformAgentSetDefaultInboxInput,
  AdminPlatformAgentVersionsListInput,
} from '../../contracts/platformAgents';
import { withLatestPublishedAssignmentVersion } from '../../contracts/platformAgents/assignmentCore';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import type { AuditAction } from '../audit/auditActionCatalog';
import { isModuleEnabled } from '../moduleSettings';
import { PlatformAuditService } from '../platformAudit';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { acquirePlatformDefaultInboxLock } from '../platformDependencyLock';
import {
  buildDefaultInboxSeed,
  DEFAULT_INBOX_GLOBAL_ASSIGNMENT,
  isDefaultInboxGlobalAssignment,
  isDefaultInboxIdentity,
  isEffectiveDefaultInboxGlobalAssignment,
  PLATFORM_DEFAULT_INBOX_AGENT_KEY,
} from './defaultInboxProvision';
import type { assertExactPlatformAgentDependencies } from './dependencyValidator';
import {
  PlatformAgentDefaultRequiredError,
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  PlatformAgentResourceInUseError,
  PlatformAgentRevisionConflictError,
} from './errors';
import { translatePlatformAgentPgError } from './pgErrors';
import {
  appendAndPublishPlatformAgentVersion,
  assertExpectedPlatformAgentIdentity,
  FIRST_PLATFORM_AGENT_VERSION,
  invalidatePlatformAgentPublication,
  observePlatformAgentPublication,
  platformAgentIdentityView,
  platformAgentMutationView,
  platformAgentVersionView,
} from './publication';

const log = debug('lobe-server:platform-agent-admin');

/** Automatic provision uses a nullable system actor — never a fake user id. */
export const DEFAULT_INBOX_BOOTSTRAP_ACTOR: string | null = null;

const classifyError = (error: unknown): string =>
  error instanceof Error ? error.name || 'Error' : 'UnknownError';

const findDefaultInboxGlobalAssignment = async (
  repository: PlatformAgentCatalogRepository,
  agentId: string,
): Promise<PlatformAgentAssignmentSafeItem | undefined> => {
  let cursor: string | undefined;
  for (;;) {
    const page = await repository.listAssignments({ agentId, cursor, limit: 100 });
    const found = page.items.find(isDefaultInboxGlobalAssignment);
    if (found) return found;
    if (!page.nextCursor) return undefined;
    cursor = page.nextCursor;
  }
};

const isHealthyDefaultInboxIdentity = (identity: PlatformAgentItem): boolean =>
  isDefaultInboxIdentity(identity) &&
  !identity.migrationRequired &&
  identity.status === 'published' &&
  Boolean(identity.currentVersionId) &&
  Boolean(identity.currentVersion?.trim());

/** Read-only health peek: no locks, no audit. */
const peekDefaultInboxProvisionHealth = async (db: LobeChatDatabase): Promise<boolean> => {
  const repository = new PlatformAgentCatalogRepository(db);
  const identity = await repository.getDefaultIdentity();
  if (!identity || !isHealthyDefaultInboxIdentity(identity)) return false;
  const assignment = await findDefaultInboxGlobalAssignment(repository, identity.id);
  return Boolean(assignment && isEffectiveDefaultInboxGlobalAssignment(assignment));
};

/**
 * Idempotent default-inbox provision for bootstrap and the admin list path.
 * Healthy catalogs return without taking locks or writing an audit row. Errors are
 * logged and never rethrown so a missing AI catalog or similar cannot crash boot / list.
 */
export const ensureDefaultInboxProvisioned = async (
  db: LobeChatDatabase,
  params: { actorId?: string | null; locale?: string } = {},
): Promise<void> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS) return;
  try {
    if (!(await isModuleEnabled('managedAgents'))) return;
    if (await peekDefaultInboxProvisionHealth(db)) return;
    await new PlatformAgentAdminService(db).provisionDefaultInbox({
      actorId: params.actorId ?? null,
      locale: params.locale,
    });
  } catch (error) {
    console.error('[platformBootstrap] default-inbox provision failed (non-blocking)', {
      errorCategory: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

const identityView = platformAgentIdentityView;
const mutationView = platformAgentMutationView;
const versionView = platformAgentVersionView;

/**
 * Stable failure-audit category. Records the mutation's failure class only — never the
 * offending value, constraint name, or target identifier (ADM-03 audit redaction).
 */
const failureAuditCategory = (error: unknown): string => {
  if (error instanceof PlatformAgentNotFoundError) return 'not_found';
  if (error instanceof PlatformAgentRevisionConflictError) return 'revision_conflict';
  if (error instanceof PlatformAgentDefaultRequiredError) return 'default_required';
  if (error instanceof PlatformAgentResourceInUseError) return 'resource_in_use';
  if (error instanceof PlatformAgentInvalidInputError) return 'invalid_input';
  return 'platform_agent_mutation_failed';
};

const assignmentView = (assignment: PlatformAgentAssignmentSafeItem) => ({
  agentId: assignment.agentId,
  enabled: assignment.enabled,
  id: assignment.id,
  mode: assignment.mode,
  pinnedVersionId: assignment.pinnedVersionId,
  targetId: assignment.targetId,
  targetType: assignment.targetType,
  versionPolicy: assignment.versionPolicy,
});

/** The default-inbox global assignment cannot be disabled, retargeted, or removed. */
const assertDefaultInboxGlobalAssignmentMutable = (
  identity: PlatformAgentItem,
  current: Pick<PlatformAgentAssignmentSafeItem, 'enabled' | 'targetId' | 'targetType'>,
  next?: Pick<PlatformAgentAssignmentSafeItem, 'enabled' | 'targetId' | 'targetType'>,
) => {
  if (!isDefaultInboxIdentity(identity) || !isDefaultInboxGlobalAssignment(current)) return;
  if (!next || !next.enabled || !isDefaultInboxGlobalAssignment(next)) {
    throw new PlatformAgentDefaultRequiredError();
  }
};

export interface PlatformAgentAdminServiceOptions {
  buildDefaultInboxSeed?: typeof buildDefaultInboxSeed;
  invalidation?: PlatformConfigInvalidationPublisher;
  validateDependencies?: typeof assertExactPlatformAgentDependencies;
}

export class PlatformAgentAdminService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly options: PlatformAgentAdminServiceOptions = {},
  ) {}

  private appendAudit = async (params: {
    action: AuditAction;
    actorUserId: string | null;
    afterDiff?: Record<string, unknown>;
    db?: LobeChatDatabase | Transaction;
    reason?: string | null;
    result: 'failure' | 'success';
    targetId: string;
  }) =>
    new PlatformAuditService(params.db ?? this.db).append({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: params.afterDiff,
      reason: params.reason,
      result: params.result,
      targetId: params.targetId,
      targetType: 'agent',
    });

  private appendFailureAudit = async (params: {
    action: AuditAction;
    actorUserId: string | null;
    errorCategory: string;
    reason?: string | null;
    targetId: string;
  }) => {
    try {
      await this.appendAudit({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: params.errorCategory },
        reason: params.reason,
        result: 'failure',
        targetId: params.targetId,
      });
    } catch (auditError) {
      log(
        'failure audit append failed class=%s',
        auditError instanceof Error ? auditError.name : 'UnknownError',
      );
    }
  };

  private atomicMutation = async <T>(params: {
    action: AuditAction;
    actorUserId: string | null;
    reason?: string | null;
    run: (tx: Transaction) => Promise<T>;
    summarize: (result: T) => Record<string, unknown>;
    targetId: string;
  }): Promise<T> => {
    try {
      return await this.db.transaction(async (tx) => {
        const result = await params.run(tx);
        await this.appendAudit({
          action: params.action,
          actorUserId: params.actorUserId,
          afterDiff: params.summarize(result),
          db: tx,
          reason: params.reason,
          result: 'success',
          targetId: params.targetId,
        });
        return result;
      });
    } catch (error) {
      // Normalize raw PostgreSQL constraint / trigger failures to stable, redacted
      // service errors before auditing or surfacing them (ADM-03).
      const mapped = translatePlatformAgentPgError(error);
      await this.appendFailureAudit({
        action: params.action,
        actorUserId: params.actorUserId,
        errorCategory: failureAuditCategory(mapped),
        reason: params.reason,
        targetId: params.targetId,
      });
      throw mapped;
    }
  };

  /**
   * Lock order (ADM-01/ADM-02): (2) per-Agent reference lock, then (3) identity FOR UPDATE.
   * The caller must already hold (1) the default-inbox singleton lock. Never row-lock the
   * identity before this — that inverts (2)/(3) and deadlocks with assignment writes.
   */
  private ensureDefaultInboxGlobalAssignment = async (
    tx: Transaction,
    repository: PlatformAgentCatalogRepository,
    agentId: string,
    actorUserId: string | null,
  ) => {
    await acquirePlatformAgentReferenceLock(tx, agentId);
    const locked = await repository.lockIdentity(agentId);
    if (!locked) throw new PlatformAgentNotFoundError();
    const identity = (await repository.backfillEmptyCurrentVersionLabel(locked)) ?? locked;
    const existing = await findDefaultInboxGlobalAssignment(repository, identity.id);
    if (existing && isEffectiveDefaultInboxGlobalAssignment(existing)) {
      return mutationView(identity);
    }
    if (existing) {
      // Runtime `listEffectiveInputs` requires enabled=true AND status='active'. A
      // leftover pending / disabled / inactive / pinned global row must be repaired, not kept.
      const updatedAssignment = await repository.updateAssignment(
        identity.id,
        existing.id,
        withLatestPublishedAssignmentVersion({
          enabled: true,
          mode: existing.mode,
          status: 'active',
          targetId: existing.targetId,
          targetType: existing.targetType,
        }),
      );
      if (!updatedAssignment) throw new PlatformAgentNotFoundError();
    } else {
      const created = await repository.createAssignment({
        agentId: identity.id,
        ...DEFAULT_INBOX_GLOBAL_ASSIGNMENT,
      });
      if (!created) throw new PlatformAgentNotFoundError();
    }
    const updated = await repository.updateDraftCas({
      expectedDraftSequence: identity.draftSequence,
      expectedRevision: identity.revision,
      id: identity.id,
      patch: { updatedBy: actorUserId },
    });
    if (!updated) throw new PlatformAgentRevisionConflictError();
    return mutationView(updated);
  };

  /**
   * De-drafted create: the identity, its first immutable version (`1.0.0`) and the published
   * pointer are written in ONE transaction, so a created Agent is live for its assignees
   * immediately. Caches are invalidated after the commit, exactly like `save`.
   */
  create = async (actorUserId: string, input: AdminPlatformAgentCreateInput) => {
    const startedAt = Date.now();
    try {
      const result = await this.atomicMutation({
        action: 'admin.agents.create',
        actorUserId,
        reason: input.reason,
        run: async (tx) => {
          // Enter the shared default-inbox singleton lock (same lock as bootstrap /
          // provisionDefaultInbox / setDefaultInbox / archive) before any validation or write.
          // Generic create can never seed the default-inbox identity.
          await acquirePlatformDefaultInboxLock(tx);
          // Reserved catalog key for the provisioned inbox. Generic create must not consume
          // it — that would make later provisioning a unique-key failure instead of an
          // idempotent repair. Platform agents have no separate slug field.
          if (
            input.agentKey === PLATFORM_DEFAULT_INBOX_AGENT_KEY ||
            input.isDefault ||
            input.systemKey !== null
          ) {
            throw new PlatformAgentInvalidInputError();
          }
          const created = await new PlatformAgentCatalogRepository(tx).createIdentity({
            agentKey: input.agentKey,
            createdBy: actorUserId,
            isDefault: false,
            systemKey: null,
          });
          const { identity, version } = await appendAndPublishPlatformAgentVersion(tx, {
            actorUserId,
            config: input.config,
            dependencySnapshot: input.dependencySnapshot,
            identity: created,
            validateDependencies: this.options.validateDependencies,
            version: FIRST_PLATFORM_AGENT_VERSION,
          });
          return { identity, version };
        },
        summarize: ({ identity, version }) => ({
          agentKey: identity.agentKey,
          revision: identity.revision,
          version: version.version,
          versionChecksum: version.checksum,
          versionId: version.id,
        }),
        targetId: input.agentKey,
      });
      const invalidationStatus = await invalidatePlatformAgentPublication({
        agentId: result.identity.id,
        invalidation: this.options.invalidation,
        revision: result.identity.revision,
      });
      observePlatformAgentPublication({ operation: 'save', startedAt });
      return {
        ...mutationView(result.identity),
        invalidationStatus,
        version: platformAgentVersionView(result.version),
      };
    } catch (error) {
      observePlatformAgentPublication({ error, operation: 'save', startedAt });
      throw error;
    }
  };

  get = async (id: string) => {
    const identity = await new PlatformAgentCatalogRepository(this.db).getIdentity(id);
    if (!identity || identity.migrationRequired) throw new PlatformAgentNotFoundError();
    return mutationView(identity);
  };

  /**
   * Idempotent bootstrap of the default-inbox identity. Called from startup / admin list
   * via `ensureDefaultInboxProvisioned`; the mutation remains as a repair path.
   */
  provisionDefaultInbox = async (params: { actorId?: string | null; locale?: string } = {}) => {
    const actorUserId = params.actorId ?? null;
    const startedAt = Date.now();
    try {
      const result = await this.atomicMutation({
        action: 'admin.agents.provisionDefaultInbox',
        actorUserId,
        run: async (tx) => {
          const repository = new PlatformAgentCatalogRepository(tx);
          await acquirePlatformDefaultInboxLock(tx);
          // Peek without FOR UPDATE so the repair path can take reference lock (2) before
          // identity (3). The singleton lock already serializes default-pointer writers.
          const existingDefault = await repository.getDefaultIdentity();
          const reserved = await repository.getIdentityByAgentKey(PLATFORM_DEFAULT_INBOX_AGENT_KEY);
          if (reserved && !isDefaultInboxIdentity(reserved)) {
            throw new PlatformAgentDefaultRequiredError(
              `Reserved agentKey '${PLATFORM_DEFAULT_INBOX_AGENT_KEY}' is already held by a non-default identity`,
            );
          }
          const existing =
            existingDefault ??
            (reserved && isDefaultInboxIdentity(reserved) ? reserved : undefined);
          if (existing) {
            const identity = await this.ensureDefaultInboxGlobalAssignment(
              tx,
              repository,
              existing.id,
              actorUserId,
            );
            return { created: false as const, identity };
          }

          const seed = await (this.options.buildDefaultInboxSeed ?? buildDefaultInboxSeed)(tx, {
            locale: params.locale,
          });
          const created = await repository.createIdentity({
            agentKey: PLATFORM_DEFAULT_INBOX_AGENT_KEY,
            createdBy: actorUserId,
            isDefault: true,
            systemKey: PLATFORM_DEFAULT_INBOX_AGENT_KEY,
          });
          const { identity: published } = await appendAndPublishPlatformAgentVersion(tx, {
            actorUserId,
            config: seed.config,
            dependencySnapshot: seed.dependencySnapshot,
            identity: created,
            validateDependencies: this.options.validateDependencies,
            version: FIRST_PLATFORM_AGENT_VERSION,
          });
          const identity = await this.ensureDefaultInboxGlobalAssignment(
            tx,
            repository,
            published.id,
            actorUserId,
          );
          return { created: true as const, identity };
        },
        summarize: ({ created, identity }) => ({
          agentKey: identity.identity.agentKey,
          created,
          locale: params.locale ?? null,
          revision: identity.identity.revision,
        }),
        targetId: PLATFORM_DEFAULT_INBOX_AGENT_KEY,
      });
      if (result.created) {
        await invalidatePlatformAgentPublication({
          agentId: result.identity.identity.id,
          invalidation: this.options.invalidation,
          revision: result.identity.identity.revision,
        });
        observePlatformAgentPublication({ operation: 'save', startedAt });
      }
      return result.identity;
    } catch (error) {
      observePlatformAgentPublication({ error, operation: 'save', startedAt });
      throw error;
    }
  };

  list = async (input: AdminPlatformAgentListInput) => {
    const repository = new PlatformAgentCatalogRepository(this.db);
    const page = await repository.listIdentities(input);
    // Constant query count regardless of page size (ADM-04): one identity page + one
    // batched version lookup + one batched assignment-count aggregate.
    const agentIds = page.items.map((identity) => identity.id);
    const versionIds = page.items
      .map((identity) => identity.currentVersionId)
      .filter((versionId): versionId is string => versionId !== null);
    const [versions, assignmentCounts] = await Promise.all([
      repository.getExactVersionsByIds(versionIds),
      repository.countAssignmentsByAgentIds(agentIds),
    ]);
    return {
      items: page.items.map((identity) => {
        const version = identity.currentVersionId
          ? versions.get(identity.currentVersionId)
          : undefined;
        return {
          assignmentCount: assignmentCounts.get(identity.id) ?? 0,
          displayName: version?.config.displayName ?? identity.agentKey,
          identity: identityView(identity),
          publishedVersion: version?.version ?? null,
        };
      }),
      nextCursor: page.nextCursor,
    };
  };

  listVersions = async (input: AdminPlatformAgentVersionsListInput) => {
    // Repository pages by opaque id cursor. Full-detail aggregates (client
    // `fetchAdminAgentDetail`) re-sort by createdAt desc after draining pages.
    const page = await new PlatformAgentCatalogRepository(this.db).listExactVersions(input);
    return { items: page.items.map(versionView), nextCursor: page.nextCursor };
  };

  listAssignments = async (input: AdminPlatformAgentAssignmentListInput) => {
    const page = await new PlatformAgentCatalogRepository(this.db).listAssignments(input);
    return { items: page.items.map(assignmentView), nextCursor: page.nextCursor };
  };

  previewAssignment = async (input: AdminPlatformAgentAssignmentPreviewInput) => {
    const repository = new PlatformAgentCatalogRepository(this.db);
    const identity = await repository.getIdentity(input.agentId);
    if (!identity || identity.migrationRequired) throw new PlatformAgentNotFoundError();
    // Pins are ignored: canonicalize before any pinned-version lookup so a stale pin cannot fail.
    const assignment = withLatestPublishedAssignmentVersion(input.assignment);
    // Build warnings independently — disabled and mandatory are orthogonal signals.
    const warnings: Array<'ASSIGNMENT_DISABLED' | 'MANDATORY_AGENT_CANNOT_BE_HIDDEN'> = [];
    if (!assignment.enabled) warnings.push('ASSIGNMENT_DISABLED');
    if (assignment.mode === 'mandatory') warnings.push('MANDATORY_AGENT_CANNOT_BE_HIDDEN');
    return {
      estimatedUsers: await repository.countAssignmentTargets(assignment),
      // Stable i18n codes only — the admin UI maps `agentCatalog.assignment.warning.${code}`.
      warnings,
    };
  };

  upsertAssignment = async (actorUserId: string, input: AdminPlatformAgentAssignmentUpsertInput) =>
    this.atomicMutation({
      action: input.assignmentId
        ? 'admin.agents.assignments.update'
        : 'admin.agents.assignments.create',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        // Reference lock (2) before the identity row lock (3): matches archive's lock order
        // so an assignment write and a concurrent archive of the same Agent serialize instead
        // of deadlocking. The repository write re-checks referenceability under this lock.
        await acquirePlatformAgentReferenceLock(tx, input.agentId);
        const locked = await repository.lockIdentity(input.agentId);
        if (!locked) throw new PlatformAgentNotFoundError();
        assertExpectedPlatformAgentIdentity(
          locked,
          input.expectedDraftToken,
          input.expectedRevision,
        );
        // Pins are ignored: canonicalize before any pinned-version lookup so a stale pin cannot fail.
        const values = withLatestPublishedAssignmentVersion({
          enabled: input.enabled,
          mode: input.mode,
          targetId: input.targetId,
          targetType: input.targetType,
        });
        if (input.assignmentId) {
          const current = await repository.getAssignment(locked.id, input.assignmentId);
          if (!current) throw new PlatformAgentNotFoundError();
          assertDefaultInboxGlobalAssignmentMutable(locked, current, values);
        } else {
          assertDefaultInboxGlobalAssignmentMutable(locked, values, values);
        }
        const assignment = input.assignmentId
          ? await repository.updateAssignment(locked.id, input.assignmentId, values)
          : await repository.createAssignment({ agentId: locked.id, ...values });
        if (!assignment) throw new PlatformAgentNotFoundError();
        const updated = await repository.updateDraftCas({
          expectedDraftSequence: locked.draftSequence,
          expectedRevision: locked.revision,
          id: locked.id,
          patch: { updatedBy: actorUserId },
        });
        if (!updated) throw new PlatformAgentRevisionConflictError();
        // Return the refreshed CAS alongside the row: the write bumped `draftSequence`, so any
        // follow-up assignment write in the same submit would otherwise need a re-GET first.
        return { assignment: assignmentView(assignment), ...mutationView(updated) };
      },
      summarize: ({ assignment }) => ({ assignmentId: assignment.id }),
      targetId: input.agentId,
    });

  removeAssignment = async (actorUserId: string, input: AdminPlatformAgentAssignmentRemoveInput) =>
    this.atomicMutation({
      action: 'admin.agents.assignments.remove',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        const locked = await repository.lockIdentity(input.agentId);
        if (!locked) throw new PlatformAgentNotFoundError();
        assertExpectedPlatformAgentIdentity(
          locked,
          input.expectedDraftToken,
          input.expectedRevision,
        );
        const current = await repository.getAssignment(locked.id, input.assignmentId);
        if (!current) throw new PlatformAgentNotFoundError();
        assertDefaultInboxGlobalAssignmentMutable(locked, current);
        const removed = await repository.deleteAssignment(locked.id, input.assignmentId);
        if (!removed) throw new PlatformAgentNotFoundError();
        const updated = await repository.updateDraftCas({
          expectedDraftSequence: locked.draftSequence,
          expectedRevision: locked.revision,
          id: locked.id,
          patch: { updatedBy: actorUserId },
        });
        if (!updated) throw new PlatformAgentRevisionConflictError();
        // Same reason as upsert: hand back the advanced CAS so a chained write needs no re-GET.
        return { removed: true as const, ...mutationView(updated) };
      },
      summarize: () => ({ assignmentId: input.assignmentId }),
      targetId: input.agentId,
    });

  setDefaultInbox = async (actorUserId: string, input: AdminPlatformAgentSetDefaultInboxInput) =>
    this.atomicMutation({
      action: 'admin.agents.setDefaultInbox',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        // Serialize every default-inbox election before touching any row, so concurrent
        // promotions (including the first, when no default row exists yet) queue instead of
        // racing the partial unique index (ADM-01).
        await acquirePlatformDefaultInboxLock(tx);
        const pointers = [
          input.nextDefault,
          ...(input.currentDefault ? [input.currentDefault] : []),
        ];
        const locked = new Map<string, PlatformAgentItem>();
        for (const id of [...new Set(pointers.map(({ agentId }) => agentId))].sort()) {
          const identity = await repository.lockIdentity(id);
          if (!identity) throw new PlatformAgentNotFoundError();
          locked.set(id, identity);
        }
        const next = locked.get(input.nextDefault.agentId)!;
        assertExpectedPlatformAgentIdentity(
          next,
          input.nextDefault.expectedDraftToken,
          input.nextDefault.expectedRevision,
        );
        if (next.status !== 'published' || !next.currentVersionId) {
          throw new PlatformAgentDefaultRequiredError();
        }
        let previousView = null;
        if (input.currentDefault) {
          const previous = locked.get(input.currentDefault.agentId)!;
          assertExpectedPlatformAgentIdentity(
            previous,
            input.currentDefault.expectedDraftToken,
            input.currentDefault.expectedRevision,
          );
          if (!previous.isDefault) throw new PlatformAgentRevisionConflictError();
          const cleared = await repository.updateDraftCas({
            expectedDraftSequence: previous.draftSequence,
            expectedRevision: previous.revision,
            id: previous.id,
            patch: { isDefault: false, systemKey: null, updatedBy: actorUserId },
          });
          if (!cleared) throw new PlatformAgentRevisionConflictError();
          previousView = mutationView(cleared);
        } else if (await repository.getDefaultIdentityForUpdate()) {
          throw new PlatformAgentRevisionConflictError();
        }
        const promoted = await repository.updateDraftCas({
          expectedDraftSequence: next.draftSequence,
          expectedRevision: next.revision,
          id: next.id,
          patch: { isDefault: true, systemKey: 'default-inbox', updatedBy: actorUserId },
        });
        if (!promoted) throw new PlatformAgentRevisionConflictError();
        return { currentDefault: previousView, nextDefault: mutationView(promoted) };
      },
      summarize: ({ currentDefault, nextDefault }) => ({
        previousAgentId: currentDefault?.identity.id ?? null,
        replacementAgentId: nextDefault.identity.id,
      }),
      targetId: input.nextDefault.agentId,
    });

  archive = async (actorUserId: string, input: AdminPlatformAgentArchiveInput) =>
    this.atomicMutation({
      action: 'admin.agents.archive',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        // Lock order (ADM-01/ADM-02): (1) default-inbox singleton — archive can hand the
        // pointer to a replacement — then (2) the per-Agent reference lock for the Agent being
        // archived, then (3) the identity rows in sorted id order.
        await acquirePlatformDefaultInboxLock(tx);
        await acquirePlatformAgentReferenceLock(tx, input.agentId);
        const ids = [
          input.agentId,
          ...(input.replacementAgentId ? [input.replacementAgentId] : []),
        ];
        const locked = new Map<string, PlatformAgentItem>();
        for (const id of [...new Set(ids)].sort()) {
          const identity = await repository.lockIdentity(id);
          if (!identity) throw new PlatformAgentNotFoundError();
          locked.set(id, identity);
        }
        const current = locked.get(input.agentId)!;
        assertExpectedPlatformAgentIdentity(
          current,
          input.expectedDraftToken,
          input.expectedRevision,
        );
        // Refuse the default pointer before counting references: a provisioned default always
        // has a locked global assignment, so resource-in-use would otherwise mask this error.
        if (current.isDefault && !input.replacementAgentId) {
          throw new PlatformAgentDefaultRequiredError();
        }
        // This phase performs no atomic reference migration: any live Assignment /
        // Materialization must be reassigned first, so archive is a stable resource-in-use
        // rejection rather than a half-done cascade (ADM-02). TOCTOU is closed by the shared
        // per-Agent reference lock (2): a concurrent reference writer either commits before us
        // — and is counted here — or wakes after us, re-reads status='archived', and is
        // rejected by the repository. FK KEY SHARE alone was insufficient because archive only
        // flips status without deleting the parent row.
        const references = await repository.countAgentReferences(current.id);
        if (references.assignments > 0 || references.materializations > 0) {
          throw new PlatformAgentResourceInUseError();
        }
        const archived = await repository.archiveIdentityCas({
          expectedDraftSequence: current.draftSequence,
          expectedRevision: current.revision,
          id: current.id,
          updatedBy: actorUserId,
        });
        if (!archived) throw new PlatformAgentRevisionConflictError();
        if (current.isDefault) {
          const replacement = locked.get(input.replacementAgentId!)!;
          if (replacement.status !== 'published' || !replacement.currentVersionId) {
            throw new PlatformAgentDefaultRequiredError();
          }
          const promoted = await repository.updateDraftCas({
            expectedDraftSequence: replacement.draftSequence,
            expectedRevision: replacement.revision,
            id: replacement.id,
            patch: { isDefault: true, systemKey: 'default-inbox', updatedBy: actorUserId },
          });
          if (!promoted) throw new PlatformAgentRevisionConflictError();
        }
        return mutationView(archived);
      },
      summarize: ({ identity }) => ({
        replacementAgentId: input.replacementAgentId,
        revision: identity.revision,
        status: identity.status,
      }),
      targetId: input.agentId,
    });

  /**
   * Irreversibly hard-delete a platform agent and every row it owns (versions, assignments,
   * materializations). Default / system agents are refused — their pointer must be reassigned via
   * setDefaultInbox first, since a hard delete has no replacement path. Local `agents` rows are
   * preserved, but materialization provenance is tombstoned so survivors stay excluded/guarded.
   */
  delete = async (actorUserId: string, input: AdminPlatformAgentDeleteInput) =>
    this.atomicMutation({
      action: 'admin.agents.delete',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const repository = new PlatformAgentCatalogRepository(tx);
        // Same lock order as archive (ADM-01/ADM-02): default-inbox singleton → per-Agent
        // reference lock (serializes assignment/materialization writers so none can orphan the
        // parent between the child deletes and the identity delete) → the identity row itself.
        await acquirePlatformDefaultInboxLock(tx);
        await acquirePlatformAgentReferenceLock(tx, input.agentId);
        const locked = await repository.lockIdentity(input.agentId);
        if (!locked || locked.migrationRequired) throw new PlatformAgentNotFoundError();
        // Full identity CAS: revision alone misses draftSequence / assignment / draft mutations.
        assertExpectedPlatformAgentIdentity(
          locked,
          input.expectedDraftToken,
          input.expectedRevision,
        );
        // A hard delete cannot reassign the default pointer, so refuse the default / any system
        // agent (the default-inbox row also auto-rebuilds only through setDefaultInbox).
        if (locked.isDefault || locked.systemKey !== null) {
          throw new PlatformAgentDefaultRequiredError();
        }
        await repository.hardDeleteAgentCascade(locked.id);
        return { agentKey: locked.agentKey, deleted: true as const };
      },
      summarize: (result) => ({ agentKey: result.agentKey }),
      targetId: input.agentId,
    }).then(() => ({ deleted: true as const }));

  getDependents = async (input: AdminPlatformAgentDependentsInput) => {
    const repository = new PlatformAgentCatalogRepository(this.db);
    const limit = input.limit ?? 50;
    const [kind, rawCursor] = input.cursor?.split(':', 2) ?? ['a', undefined];
    if (kind !== 'a' && kind !== 'm') throw new PlatformAgentRevisionConflictError();

    // Collect dependents with their (optional) version id first, then resolve every version
    // in a single batched query — keeping the query count constant per page (ADM-04).
    const drafts: Array<{
      id: string;
      key: string;
      name: string;
      type: 'assignment' | 'materialization';
      versionId: string | null;
    }> = [];
    let nextCursor: string | null = null;
    let includeMaterializations = kind === 'm';

    if (kind === 'a') {
      const assignments = await repository.listAssignments({
        agentId: input.agentId,
        cursor: rawCursor || undefined,
        limit,
      });
      for (const assignment of assignments.items) {
        drafts.push({
          id: assignment.id,
          key: `${assignment.targetType}:${assignment.targetId}`,
          name: `${assignment.targetType}:${assignment.targetId}`,
          type: 'assignment',
          versionId: assignment.pinnedVersionId,
        });
      }
      if (assignments.nextCursor) {
        nextCursor = `a:${assignments.nextCursor}`;
      } else if (drafts.length >= limit) {
        nextCursor = 'm:';
      } else {
        includeMaterializations = true;
      }
    }

    if (includeMaterializations) {
      const materializations = await repository.listDependentMaterializations({
        agentId: input.agentId,
        cursor: kind === 'm' ? rawCursor || undefined : undefined,
        limit: limit - drafts.length,
      });
      for (const materialization of materializations.items) {
        drafts.push({
          id: materialization.id,
          key: materialization.userId,
          name: materialization.userId,
          type: 'materialization',
          versionId: materialization.versionId,
        });
      }
      nextCursor = materializations.nextCursor ? `m:${materializations.nextCursor}` : null;
    }

    const versionIds = drafts
      .map((draft) => draft.versionId)
      .filter((versionId): versionId is string => versionId !== null);
    const versions = await repository.getExactVersionsByIds(versionIds);
    return {
      items: drafts.map((draft) => ({
        id: draft.id,
        key: draft.key,
        name: draft.name,
        type: draft.type,
        version: draft.versionId ? (versions.get(draft.versionId)?.version ?? null) : null,
      })),
      nextCursor,
    };
  };
}
