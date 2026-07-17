import {
  PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
  PLATFORM_AGENT_GLOBAL_TARGET_ID,
} from '@lobechat/types';

import type {
  AdminAgentDetailOutput,
  AdminAgentListItem,
  AdminAgentsClient,
} from './types';

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
        status: 'running',
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
        status: 'dead',
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
    ...detail.identity,
    assignmentCount: detail.assignments.length,
    displayName: current?.config.displayName ?? detail.identity.agentKey,
    publishedVersion: detail.identity.status === 'published' ? (current?.version ?? null) : null,
  };
};

export const createMockAdminAgentsClient = (): AdminAgentsClient => {
  const records = new Map(seedAgents().map((record) => [record.identity.id, record]));
  const requireRecord = (id: string) => {
    const record = records.get(id);
    if (!record) throw new Error('PLATFORM_AGENT_NOT_FOUND');
    return record;
  };
  const nextToken = (revision: number) => checksum(revision.toString(16));

  return {
    appendVersion: async (input) => {
      const record = requireRecord(input.agentId);
      const id = `version-${input.agentId}-${record.versions.length + 1}`;
      record.versions.unshift({
        agentId: input.agentId,
        checksum: checksum(id),
        config: input.config,
        createdAt: new Date(),
        createdBy: 'mock-admin',
        dependencySnapshot: input.dependencySnapshot,
        id,
        version: input.version,
      });
      record.identity = {
        ...record.identity,
        currentVersionId: id,
        draftSequence: record.identity.draftSequence + 1,
        revision: record.identity.revision + 1,
        status: 'draft',
      };
      record.draftToken = nextToken(record.identity.revision);
      return { draftToken: record.draftToken, identity: record.identity };
    },
    archive: async (input) => {
      const record = requireRecord(input.agentId);
      record.identity = {
        ...record.identity,
        revision: record.identity.revision + 1,
        status: 'archived',
      };
      record.draftToken = nextToken(record.identity.revision);
      return { draftToken: record.draftToken, identity: record.identity };
    },
    cancelRollout: async (input) => {
      const rollout = requireRecord(input.agentId).rollouts.find(({ jobId }) => jobId === input.jobId);
      if (!rollout) throw new Error('PLATFORM_AGENT_ROLLOUT_NOT_FOUND');
      rollout.status = 'cancelled';
      rollout.updatedAt = new Date();
      return rollout;
    },
    create: async (input) => {
      const id = `agent-${crypto.randomUUID()}`;
      const identity = {
        agentKey: input.agentKey,
        currentVersionId: null,
        draftSequence: 0,
        id,
        isDefault: input.isDefault,
        migrationRequired: false,
        revision: 0,
        status: 'draft' as const,
        systemKey: input.systemKey,
      };
      const draftToken = nextToken(0);
      records.set(id, { assignments: [], draftToken, identity, rollouts: [], versions: [] });
      return { draftToken, identity };
    },
    createAssignment: async (input) => {
      const record = requireRecord(input.agentId);
      const assignment = { ...input, id: `assignment-${crypto.randomUUID()}` };
      const { reason: _, ...publicAssignment } = assignment;
      record.assignments.push(publicAssignment);
      return publicAssignment;
    },
    deleteAssignment: async (input) => {
      const record = requireRecord(input.agentId);
      record.assignments = record.assignments.filter(({ id }) => id !== input.assignmentId);
    },
    get: async ({ id }) => structuredClone(requireRecord(id)),
    list: async (input) => {
      const query = input.query?.trim().toLocaleLowerCase();
      const items = [...records.values()].map(toListItem).filter((item) => {
        if (input.status && item.status !== input.status) return false;
        if (!query) return true;
        return `${item.displayName} ${item.agentKey}`.toLocaleLowerCase().includes(query);
      });
      return { items };
    },
    previewAssignment: async ({ assignment }) => ({
      estimatedUsers:
        assignment.targetType === 'global' ? 1200 : assignment.targetType === 'global_role' ? 84 : 1,
      warnings: assignment.mode === 'mandatory' ? ['MANDATORY_AGENT_CANNOT_BE_HIDDEN'] : [],
    }),
    publish: async (input) => {
      const record = requireRecord(input.agentId);
      record.identity = {
        ...record.identity,
        currentVersionId: input.versionId,
        revision: record.identity.revision + 1,
        status: 'published',
      };
      record.draftToken = nextToken(record.identity.revision);
      return { draftToken: record.draftToken, identity: record.identity };
    },
    retryRollout: async (input) => {
      const rollout = requireRecord(input.agentId).rollouts.find(({ jobId }) => jobId === input.jobId);
      if (!rollout) throw new Error('PLATFORM_AGENT_ROLLOUT_NOT_FOUND');
      rollout.status = 'pending';
      rollout.updatedAt = new Date();
      return rollout;
    },
    rollback: async (input) => {
      const record = requireRecord(input.agentId);
      record.identity = {
        ...record.identity,
        currentVersionId: input.versionId,
        revision: record.identity.revision + 1,
        status: 'published',
      };
      record.draftToken = nextToken(record.identity.revision);
      return { draftToken: record.draftToken, identity: record.identity };
    },
    startRollout: async (input) => {
      const record = requireRecord(input.agentId);
      const rollout = {
        assignmentId: input.assignmentId,
        completed: 0,
        cursor: null,
        failed: 0,
        jobId: `rollout-${crypto.randomUUID()}`,
        status: 'pending' as const,
        total: 1200,
        updatedAt: new Date(),
      };
      record.rollouts.unshift(rollout);
      return rollout;
    },
  };
};
