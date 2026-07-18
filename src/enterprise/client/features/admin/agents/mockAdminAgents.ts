import {
  PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
  PLATFORM_AGENT_GLOBAL_TARGET_ID,
} from '@lobechat/types';

import {
  adminPlatformAgentAppendVersionOutputSchema,
  adminPlatformAgentArchiveOutputSchema,
  adminPlatformAgentAssignmentListOutputSchema,
  adminPlatformAgentAssignmentPreviewOutputSchema,
  adminPlatformAgentAssignmentRemoveOutputSchema,
  adminPlatformAgentAssignmentUpsertOutputSchema,
  adminPlatformAgentCreateOutputSchema,
  adminPlatformAgentDependentsOutputSchema,
  adminPlatformAgentGetOutputSchema,
  adminPlatformAgentListOutputSchema,
  adminPlatformAgentPublishOutputSchema,
  adminPlatformAgentRollbackOutputSchema,
  adminPlatformAgentRolloutCancelOutputSchema,
  adminPlatformAgentRolloutGetOutputSchema,
  adminPlatformAgentRolloutListOutputSchema,
  adminPlatformAgentRolloutRetryOutputSchema,
  adminPlatformAgentRolloutRollbackOutputSchema,
  adminPlatformAgentRolloutStartOutputSchema,
  adminPlatformAgentSetDefaultInboxOutputSchema,
  adminPlatformAgentUpdateDraftOutputSchema,
  adminPlatformAgentValidateDependenciesOutputSchema,
  adminPlatformAgentVersionsListOutputSchema,
} from '@/server/enterprise/contracts/platformAgents';

import type { AdminAgentDetailOutput, AdminAgentListItem, AdminAgentsClient } from './types';

const checksum = (seed: string) => seed.padEnd(64, seed.at(-1) ?? '0').slice(0, 64);

const seedAgents = (): AdminAgentDetailOutput[] => [
  {
    assignments: [
      {
        agentId: 'agent-inbox',
        enabled: true,
        id: 'assignment-inbox-global',
        mode: 'mandatory',
        pinnedVersionId: null,
        targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
        targetType: 'global',
        versionPolicy: 'latest_published',
      },
    ],
    draftToken: checksum('a'),
    identity: {
      agentKey: 'organization-inbox',
      currentVersionId: 'version-inbox-1',
      draftSequence: 1,
      id: 'agent-inbox',
      isDefault: true,
      migrationRequired: false,
      revision: 3,
      status: 'published',
      systemKey: PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
    },
    rollouts: [
      {
        assignmentId: 'assignment-inbox-global',
        completed: 820,
        cursor: 'user-0820',
        failed: 2,
        jobId: 'rollout-inbox-1',
        previousVersionId: null,
        revision: 1,
        status: 'running',
        targetVersionId: 'version-inbox-1',
        total: 1200,
        updatedAt: new Date('2026-07-17T06:00:00.000Z'),
      },
    ],
    versions: [
      {
        agentId: 'agent-inbox',
        checksum: checksum('b'),
        config: {
          avatar: null,
          backgroundColor: '#222222',
          description: 'Organization-managed default Agent.',
          displayName: 'AIHub AI',
          modelParameters: { temperature: 0.7 },
          openingMessage: 'How can I help today?',
          openingQuestions: ['Summarize this document', 'Plan my next steps'],
          systemRole: 'You are the organization default Agent.',
          tags: ['organization', 'default'],
        },
        createdAt: new Date('2026-07-16T06:00:00.000Z'),
        createdBy: 'admin-1',
        dependencySnapshot: {
          connectors: [],
          model: {
            modelKey: 'gpt-4.1',
            providerChecksum: checksum('c'),
            providerKey: 'openai',
            providerRevision: 4,
          },
          skills: [],
        },
        id: 'version-inbox-1',
        version: '1.0.0',
      },
    ],
  },
  {
    assignments: [],
    draftToken: checksum('d'),
    identity: {
      agentKey: 'research-assistant',
      currentVersionId: 'version-research-1',
      draftSequence: 2,
      id: 'agent-research',
      isDefault: false,
      migrationRequired: false,
      revision: 2,
      status: 'draft',
      systemKey: null,
    },
    rollouts: [
      {
        assignmentId: 'assignment-research-role',
        completed: 45,
        cursor: null,
        failed: 5,
        jobId: 'rollout-research-dead',
        previousVersionId: null,
        revision: 2,
        status: 'dead',
        targetVersionId: 'version-research-1',
        total: 50,
        updatedAt: new Date('2026-07-16T08:00:00.000Z'),
      },
    ],
    versions: [
      {
        agentId: 'agent-research',
        checksum: checksum('e'),
        config: {
          avatar: null,
          backgroundColor: '#4f46e5',
          description: 'Research synthesis for product teams.',
          displayName: 'Research Assistant',
          modelParameters: { temperature: 0.3 },
          openingMessage: null,
          openingQuestions: ['Compare these sources'],
          systemRole: 'Synthesize evidence and clearly mark uncertainty.',
          tags: ['research'],
        },
        createdAt: new Date('2026-07-15T06:00:00.000Z'),
        createdBy: 'admin-1',
        dependencySnapshot: {
          connectors: [],
          model: {
            modelKey: 'claude-sonnet-4',
            providerChecksum: checksum('f'),
            providerKey: 'anthropic',
            providerRevision: 2,
          },
          skills: [],
        },
        id: 'version-research-1',
        version: '0.2.0',
      },
    ],
  },
];

const toListItem = (detail: AdminAgentDetailOutput): AdminAgentListItem => {
  const current = detail.versions.find(({ id }) => id === detail.identity.currentVersionId);
  return {
    assignmentCount: detail.assignments.length,
    displayName: current?.config.displayName ?? detail.identity.agentKey,
    identity: detail.identity,
    publishedVersion: detail.identity.status === 'published' ? (current?.version ?? null) : null,
  };
};

const page = <T>(items: T[], cursor: string | undefined, limit = 50) => {
  const offset = cursor ? Number(cursor) : 0;
  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  return { items: pageItems, nextCursor: nextOffset < items.length ? String(nextOffset) : null };
};

export const createMockAdminAgentsClient = (): AdminAgentsClient => {
  const records = new Map(seedAgents().map((record) => [record.identity.id, record]));
  const requireRecord = (id: string) => {
    const record = records.get(id);
    if (!record) throw new Error('PLATFORM_AGENT_NOT_FOUND');
    return record;
  };
  const nextToken = (revision: number) => checksum(revision.toString(16));
  const requireCas = (id: string, expectedRevision: number, expectedDraftToken: string) => {
    const record = requireRecord(id);
    if (record.identity.revision !== expectedRevision || record.draftToken !== expectedDraftToken) {
      throw new Error('PLATFORM_AGENT_CONFLICT');
    }
    return record;
  };
  const advanceAgent = (record: AdminAgentDetailOutput) => {
    record.identity = { ...record.identity, revision: record.identity.revision + 1 };
    record.draftToken = nextToken(record.identity.revision);
  };
  const requireRollout = (agentId: string, jobId: string) => {
    const rollout = requireRecord(agentId).rollouts.find((item) => item.jobId === jobId);
    if (!rollout) throw new Error('PLATFORM_AGENT_ROLLOUT_NOT_FOUND');
    return rollout;
  };
  const requireRolloutCas = (
    agentId: string,
    jobId: string,
    expectedJobRevision: number,
    expectedStatus: string,
  ) => {
    const rollout = requireRollout(agentId, jobId);
    if (rollout.revision !== expectedJobRevision || rollout.status !== expectedStatus) {
      throw new Error('PLATFORM_AGENT_ROLLOUT_CONFLICT');
    }
    return rollout;
  };

  return {
    capabilities: { rollouts: true },
    appendVersion: async (input) => {
      const record = requireCas(input.agentId, input.expectedRevision, input.expectedDraftToken);
      const id = `version-${input.agentId}-${record.versions.length + 1}`;
      const version = {
        agentId: input.agentId,
        checksum: checksum(record.versions.length.toString(16)),
        config: input.config,
        createdAt: new Date(),
        createdBy: 'mock-admin',
        dependencySnapshot: input.dependencySnapshot,
        id,
        version: input.version,
      };
      record.versions.unshift(version);
      record.identity = {
        ...record.identity,
        draftSequence: record.identity.draftSequence + 1,
        revision: record.identity.revision + 1,
        status: 'draft',
      };
      record.draftToken = nextToken(record.identity.revision);
      return adminPlatformAgentAppendVersionOutputSchema.parse({
        draftToken: record.draftToken,
        identity: record.identity,
        version,
      });
    },
    archive: async (input) => {
      const record = requireCas(input.agentId, input.expectedRevision, input.expectedDraftToken);
      if (record.identity.isDefault && input.replacementAgentId === null) {
        throw new Error('PLATFORM_AGENT_DEFAULT_REPLACEMENT_REQUIRED');
      }
      const replacement = input.replacementAgentId ? requireRecord(input.replacementAgentId) : null;
      if (replacement && replacement.identity.status !== 'published') {
        throw new Error('PLATFORM_AGENT_DEFAULT_MUST_BE_PUBLISHED');
      }
      record.identity = {
        ...record.identity,
        isDefault: false,
        revision: record.identity.revision + 1,
        status: 'archived',
        systemKey: null,
      };
      record.draftToken = nextToken(record.identity.revision);
      if (replacement) {
        replacement.identity = {
          ...replacement.identity,
          isDefault: true,
          revision: replacement.identity.revision + 1,
          systemKey: PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
        };
        replacement.draftToken = nextToken(replacement.identity.revision);
      }
      return adminPlatformAgentArchiveOutputSchema.parse({
        draftToken: record.draftToken,
        identity: record.identity,
      });
    },
    cancelRollout: async (input) => {
      const rollout = requireRolloutCas(
        input.agentId,
        input.jobId,
        input.expectedJobRevision,
        input.expectedStatus,
      );
      rollout.status = 'cancelled';
      rollout.revision += 1;
      rollout.updatedAt = new Date();
      return adminPlatformAgentRolloutCancelOutputSchema.parse(rollout);
    },
    create: async (input) => {
      if (input.isDefault && [...records.values()].some(({ identity }) => identity.isDefault)) {
        throw new Error('PLATFORM_AGENT_DEFAULT_ALREADY_EXISTS');
      }
      const id = `agent-${crypto.randomUUID()}`;
      const identity = {
        agentKey: input.agentKey,
        currentVersionId: null,
        draftSequence: 0,
        id,
        isDefault: input.isDefault ?? false,
        migrationRequired: false,
        revision: 0,
        status: 'draft' as const,
        systemKey: input.systemKey ?? null,
      };
      const draftToken = nextToken(0);
      records.set(id, { assignments: [], draftToken, identity, rollouts: [], versions: [] });
      return adminPlatformAgentCreateOutputSchema.parse({ draftToken, identity });
    },
    get: async ({ id }) => {
      const record = requireRecord(id);
      return adminPlatformAgentGetOutputSchema.parse(
        structuredClone({ draftToken: record.draftToken, identity: record.identity }),
      );
    },
    getDependents: async ({ agentId, cursor, limit }) => {
      const record = requireRecord(agentId);
      const items = record.assignments.map((assignment) => ({
        id: assignment.id,
        key: `${assignment.targetType}:${assignment.targetId}`,
        name: assignment.targetId,
        type: 'assignment' as const,
        version: null,
      }));
      return adminPlatformAgentDependentsOutputSchema.parse(page(items, cursor, limit));
    },
    getRollout: async ({ agentId, jobId }) =>
      adminPlatformAgentRolloutGetOutputSchema.parse(
        structuredClone(requireRollout(agentId, jobId)),
      ),
    list: async (input) => {
      const query = input.query?.trim().toLocaleLowerCase();
      const items = [...records.values()].map(toListItem).filter((item) => {
        if (input.status && item.identity.status !== input.status) return false;
        if (!query) return true;
        return `${item.displayName} ${item.identity.agentKey}`.toLocaleLowerCase().includes(query);
      });
      return adminPlatformAgentListOutputSchema.parse(page(items, input.cursor, input.limit ?? 50));
    },
    listAssignments: async ({ agentId, cursor, limit }) =>
      adminPlatformAgentAssignmentListOutputSchema.parse(
        page(structuredClone(requireRecord(agentId).assignments), cursor, limit),
      ),
    listRollouts: async ({ agentId, cursor, limit }) =>
      adminPlatformAgentRolloutListOutputSchema.parse(
        page(structuredClone(requireRecord(agentId).rollouts), cursor, limit),
      ),
    listVersions: async ({ agentId, cursor, limit }) =>
      adminPlatformAgentVersionsListOutputSchema.parse(
        page(structuredClone(requireRecord(agentId).versions), cursor, limit),
      ),
    previewAssignment: async ({ assignment }) =>
      adminPlatformAgentAssignmentPreviewOutputSchema.parse({
        estimatedUsers:
          assignment.targetType === 'global'
            ? 1200
            : assignment.targetType === 'global_role'
              ? 84
              : 1,
        warnings: assignment.mode === 'mandatory' ? ['MANDATORY_AGENT_CANNOT_BE_HIDDEN'] : [],
      }),
    publish: async (input) => {
      const record = requireCas(input.agentId, input.expectedRevision, input.expectedDraftToken);
      const version = record.versions.find(({ id }) => id === input.versionId);
      if (!version) throw new Error('PLATFORM_AGENT_VERSION_NOT_FOUND');
      record.identity = {
        ...record.identity,
        currentVersionId: version.id,
        revision: record.identity.revision + 1,
        status: 'published',
      };
      record.draftToken = nextToken(record.identity.revision);
      return adminPlatformAgentPublishOutputSchema.parse({
        agentId: input.agentId,
        revision: record.identity.revision,
        versionId: version.id,
      });
    },
    removeAssignment: async (input) => {
      const record = requireCas(input.agentId, input.expectedRevision, input.expectedDraftToken);
      record.assignments = record.assignments.filter(({ id }) => id !== input.assignmentId);
      advanceAgent(record);
      return adminPlatformAgentAssignmentRemoveOutputSchema.parse({ removed: true });
    },
    retryRollout: async (input) => {
      const rollout = requireRolloutCas(
        input.agentId,
        input.jobId,
        input.expectedJobRevision,
        input.expectedStatus,
      );
      rollout.status = 'pending';
      rollout.revision += 1;
      rollout.updatedAt = new Date();
      return adminPlatformAgentRolloutRetryOutputSchema.parse(rollout);
    },
    rollback: async (input) => {
      const record = requireCas(input.agentId, input.expectedRevision, input.expectedDraftToken);
      const version = record.versions.find(({ id }) => id === input.targetVersionId);
      if (!version) throw new Error('PLATFORM_AGENT_VERSION_NOT_FOUND');
      record.identity = {
        ...record.identity,
        currentVersionId: version.id,
        revision: record.identity.revision + 1,
        status: 'published',
      };
      record.draftToken = nextToken(record.identity.revision);
      return adminPlatformAgentRollbackOutputSchema.parse({
        agentId: input.agentId,
        revision: record.identity.revision,
        versionId: version.id,
      });
    },
    rollbackRollout: async (input) => {
      const rollout = requireRolloutCas(
        input.agentId,
        input.jobId,
        input.expectedJobRevision,
        input.expectedStatus,
      );
      rollout.status = 'pending';
      rollout.revision += 1;
      rollout.updatedAt = new Date();
      return adminPlatformAgentRolloutRollbackOutputSchema.parse(rollout);
    },
    setDefaultInbox: async (input) => {
      const current = input.currentDefault
        ? requireCas(
            input.currentDefault.agentId,
            input.currentDefault.expectedRevision,
            input.currentDefault.expectedDraftToken,
          )
        : null;
      const next = requireCas(
        input.nextDefault.agentId,
        input.nextDefault.expectedRevision,
        input.nextDefault.expectedDraftToken,
      );
      if (next.identity.status !== 'published') {
        throw new Error('PLATFORM_AGENT_DEFAULT_MUST_BE_PUBLISHED');
      }
      if (current) {
        current.identity = {
          ...current.identity,
          isDefault: false,
          revision: current.identity.revision + 1,
          systemKey: null,
        };
        current.draftToken = nextToken(current.identity.revision);
      }
      next.identity = {
        ...next.identity,
        isDefault: true,
        revision: next.identity.revision + 1,
        systemKey: PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
      };
      next.draftToken = nextToken(next.identity.revision);
      return adminPlatformAgentSetDefaultInboxOutputSchema.parse({
        currentDefault: current
          ? { draftToken: current.draftToken, identity: current.identity }
          : null,
        nextDefault: { draftToken: next.draftToken, identity: next.identity },
      });
    },
    startRollout: async (input) => {
      const record = requireCas(input.agentId, input.expectedRevision, input.expectedDraftToken);
      const rollout = {
        assignmentId: input.assignmentId,
        completed: 0,
        cursor: null,
        failed: 0,
        jobId: `rollout-${crypto.randomUUID()}`,
        previousVersionId: null,
        revision: 0,
        status: 'pending' as const,
        targetVersionId: record.identity.currentVersionId!,
        total: 1200,
        updatedAt: new Date(),
      };
      record.rollouts.unshift(rollout);
      return adminPlatformAgentRolloutStartOutputSchema.parse(rollout);
    },
    updateDraft: async (input) => {
      const record = requireCas(input.agentId, input.expectedRevision, input.expectedDraftToken);
      record.identity = {
        ...record.identity,
        isDefault: input.isDefault,
        revision: record.identity.revision + 1,
        systemKey: input.systemKey,
      };
      record.draftToken = nextToken(record.identity.revision);
      return adminPlatformAgentUpdateDraftOutputSchema.parse({
        draftToken: record.draftToken,
        identity: record.identity,
      });
    },
    upsertAssignment: async (input) => {
      const record = requireCas(input.agentId, input.expectedRevision, input.expectedDraftToken);
      const assignment = {
        agentId: input.agentId,
        enabled: input.enabled,
        id: input.assignmentId ?? `assignment-${crypto.randomUUID()}`,
        mode: input.mode,
        pinnedVersionId: input.pinnedVersionId,
        targetId: input.targetId,
        targetType: input.targetType,
        versionPolicy: input.versionPolicy,
      };
      const index = record.assignments.findIndex(({ id }) => id === assignment.id);
      if (index === -1) record.assignments.push(assignment);
      else record.assignments[index] = assignment;
      advanceAgent(record);
      return adminPlatformAgentAssignmentUpsertOutputSchema.parse(assignment);
    },
    validateDependencies: async () =>
      adminPlatformAgentValidateDependenciesOutputSchema.parse({ valid: true }),
  };
};
