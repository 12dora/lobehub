import {
  type ExactPlatformAgentVersion,
  type PlatformAgentAssignmentSafeItem,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import type { PlatformAgentItem } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminPlatformAgentAppendVersionInput,
  AdminPlatformAgentArchiveInput,
  AdminPlatformAgentAssignmentListInput,
  AdminPlatformAgentAssignmentPreviewInput,
  AdminPlatformAgentAssignmentRemoveInput,
  AdminPlatformAgentAssignmentUpsertInput,
  AdminPlatformAgentCreateInput,
  AdminPlatformAgentDependentsInput,
  AdminPlatformAgentListInput,
  AdminPlatformAgentSetDefaultInboxInput,
  AdminPlatformAgentUpdateDraftInput,
  AdminPlatformAgentVersionsListInput,
} from '../../contracts/platformAgents';
import { PlatformAuditService } from '../platformAudit';
import { acquirePlatformDependencyPublicationLock } from '../platformDependencyLock';
import { assertExactPlatformAgentDependencies } from './dependencyValidator';
import {
  PlatformAgentDefaultRequiredError,
  PlatformAgentNotFoundError,
  PlatformAgentRevisionConflictError,
} from './errors';
import { assertExpectedPlatformAgentIdentity, platformAgentDraftToken } from './publication';

const identityView = (identity: PlatformAgentItem) => ({
  agentKey: identity.agentKey,
  currentVersionId: identity.currentVersionId,
  draftSequence: identity.draftSequence,
  id: identity.id,
  isDefault: identity.isDefault,
  migrationRequired: identity.migrationRequired,
  revision: identity.revision,
  status: identity.status as 'archived' | 'draft' | 'published',
  systemKey: identity.systemKey === 'default-inbox' ? identity.systemKey : null,
});

const mutationView = (identity: PlatformAgentItem) => ({
  draftToken: platformAgentDraftToken(identity),
  identity: identityView(identity),
});

const versionView = (version: ExactPlatformAgentVersion) => ({
  agentId: version.agentId,
  checksum: version.checksum,
  config: version.config,
  createdAt: version.createdAt,
  createdBy: version.createdBy,
  dependencySnapshot: version.dependencySnapshot,
  id: version.id,
  version: version.version,
});

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

export class PlatformAgentAdminService {
  constructor(private readonly db: LobeChatDatabase) {}

  private appendAudit = async (params: {
    action: string;
    actorUserId: string;
    afterDiff?: Record<string, unknown>;
    db?: LobeChatDatabase | Transaction;
    reason: string;
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
    action: string;
    actorUserId: string;
    reason: string;
    targetId: string;
  }) => {
    try {
      await this.appendAudit({
        ...params,
        afterDiff: { error: 'platform_agent_mutation_failed' },
        result: 'failure',
      });
    } catch (auditError) {
      console.error('[admin.agents] failure audit append failed', {
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
  };

  private atomicMutation = async <T>(params: {
    action: string;
    actorUserId: string;
    reason: string;
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
      await this.appendFailureAudit(params);
      throw error;
    }
  };

  create = async (actorUserId: string, input: AdminPlatformAgentCreateInput) =>
    this.atomicMutation({
      action: 'admin.agents.create',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const identity = await new PlatformAgentCatalogRepository(tx).createIdentity({
          agentKey: input.agentKey,
          createdBy: actorUserId,
          isDefault: input.isDefault ?? false,
          systemKey: input.systemKey ?? null,
        });
        return mutationView(identity);
      },
      summarize: ({ identity }) => ({ agentKey: identity.agentKey }),
      targetId: input.agentKey,
    });

  get = async (id: string) => {
    const identity = await new PlatformAgentCatalogRepository(this.db).getIdentity(id);
    if (!identity || identity.migrationRequired) throw new PlatformAgentNotFoundError();
    return mutationView(identity);
  };

  list = async (input: AdminPlatformAgentListInput) => {
    const repository = new PlatformAgentCatalogRepository(this.db);
    const page = await repository.listIdentities(input);
    return {
      items: await Promise.all(
        page.items.map(async (identity) => {
          const version = identity.currentVersionId
            ? await repository.getExactVersion(identity.id, identity.currentVersionId)
            : undefined;
          return {
            assignmentCount: await repository.countAssignments(identity.id),
            displayName: version?.config.displayName ?? identity.agentKey,
            identity: identityView(identity),
            publishedVersion: version?.version ?? null,
          };
        }),
      ),
      nextCursor: page.nextCursor,
    };
  };

  updateDraft = async (actorUserId: string, input: AdminPlatformAgentUpdateDraftInput) =>
    this.atomicMutation({
      action: 'admin.agents.updateDraft',
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
        const updated = await repository.updateDraftCas({
          expectedDraftSequence: locked.draftSequence,
          expectedRevision: locked.revision,
          id: locked.id,
          patch: {
            isDefault: input.isDefault,
            systemKey: input.systemKey,
            updatedBy: actorUserId,
          },
        });
        if (!updated) throw new PlatformAgentRevisionConflictError();
        return mutationView(updated);
      },
      summarize: ({ identity }) => ({ draftSequence: identity.draftSequence }),
      targetId: input.agentId,
    });

  appendVersion = async (actorUserId: string, input: AdminPlatformAgentAppendVersionInput) =>
    this.atomicMutation({
      action: 'admin.agents.createVersion',
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
        await acquirePlatformDependencyPublicationLock(tx);
        await assertExactPlatformAgentDependencies(tx, input.dependencySnapshot);
        const version = await repository.appendVersionCas({
          agentId: locked.id,
          config: input.config,
          createdBy: actorUserId,
          dependencySnapshot: input.dependencySnapshot,
          expectedDraftSequence: locked.draftSequence,
          expectedRevision: locked.revision,
          version: input.version,
        });
        if (!version) throw new PlatformAgentRevisionConflictError();
        const identity = await repository.getIdentity(locked.id);
        if (!identity) throw new PlatformAgentNotFoundError();
        return { ...mutationView(identity), version: versionView(version) };
      },
      summarize: ({ identity, version }) => ({
        draftSequence: identity.draftSequence,
        version: version.version,
        versionChecksum: version.checksum,
        versionId: version.id,
      }),
      targetId: input.agentId,
    });

  listVersions = async (input: AdminPlatformAgentVersionsListInput) => {
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
    if (input.assignment.pinnedVersionId) {
      const version = await repository.getExactVersion(
        input.agentId,
        input.assignment.pinnedVersionId,
      );
      if (!version) throw new PlatformAgentNotFoundError();
    }
    return {
      estimatedUsers: await repository.countAssignmentTargets(input.assignment),
      warnings: input.assignment.enabled ? [] : ['Assignment is disabled and will not take effect'],
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
        const locked = await repository.lockIdentity(input.agentId);
        if (!locked) throw new PlatformAgentNotFoundError();
        assertExpectedPlatformAgentIdentity(
          locked,
          input.expectedDraftToken,
          input.expectedRevision,
        );
        if (input.pinnedVersionId) {
          const pinned = await repository.getExactVersion(locked.id, input.pinnedVersionId);
          if (!pinned) throw new PlatformAgentNotFoundError();
        }
        const values = {
          enabled: input.enabled,
          mode: input.mode,
          pinnedVersionId: input.pinnedVersionId,
          targetId: input.targetId,
          targetType: input.targetType,
          versionPolicy: input.versionPolicy,
        };
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
        return assignmentView(assignment);
      },
      summarize: (assignment) => ({ assignmentId: assignment.id }),
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
        const removed = await repository.deleteAssignment(locked.id, input.assignmentId);
        if (!removed) throw new PlatformAgentNotFoundError();
        const updated = await repository.updateDraftCas({
          expectedDraftSequence: locked.draftSequence,
          expectedRevision: locked.revision,
          id: locked.id,
          patch: { updatedBy: actorUserId },
        });
        if (!updated) throw new PlatformAgentRevisionConflictError();
        return { removed: true as const };
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
        if (current.isDefault && !input.replacementAgentId) {
          throw new PlatformAgentDefaultRequiredError();
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

  getDependents = async (input: AdminPlatformAgentDependentsInput) => {
    const repository = new PlatformAgentCatalogRepository(this.db);
    const limit = input.limit ?? 50;
    const [kind, rawCursor] = input.cursor?.split(':', 2) ?? ['a', undefined];
    if (kind !== 'a' && kind !== 'm') throw new PlatformAgentRevisionConflictError();
    const items: Array<{
      id: string;
      key: string;
      name: string;
      type: 'assignment' | 'materialization';
      version: string | null;
    }> = [];
    if (kind === 'a') {
      const assignments = await repository.listAssignments({
        agentId: input.agentId,
        cursor: rawCursor || undefined,
        limit,
      });
      for (const assignment of assignments.items) {
        const version = assignment.pinnedVersionId
          ? await repository.getExactVersion(input.agentId, assignment.pinnedVersionId)
          : undefined;
        items.push({
          id: assignment.id,
          key: `${assignment.targetType}:${assignment.targetId}`,
          name: `${assignment.targetType}:${assignment.targetId}`,
          type: 'assignment',
          version: version?.version ?? null,
        });
      }
      if (assignments.nextCursor) {
        return { items, nextCursor: `a:${assignments.nextCursor}` };
      }
      if (items.length >= limit) return { items, nextCursor: 'm:' };
    }
    const materializations = await repository.listDependentMaterializations({
      agentId: input.agentId,
      cursor: kind === 'm' ? rawCursor || undefined : undefined,
      limit: limit - items.length,
    });
    for (const materialization of materializations.items) {
      const version = await repository.getExactVersion(input.agentId, materialization.versionId);
      items.push({
        id: materialization.id,
        key: materialization.userId,
        name: materialization.userId,
        type: 'materialization',
        version: version?.version ?? null,
      });
    }
    return {
      items,
      nextCursor: materializations.nextCursor ? `m:${materializations.nextCursor}` : null,
    };
  };
}
