import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  adminPlatformAgentAppendVersionInputSchema,
  adminPlatformAgentArchiveInputSchema,
  adminPlatformAgentAssignmentListOutputSchema,
  adminPlatformAgentAssignmentPreviewInputSchema,
  adminPlatformAgentAssignmentRemoveInputSchema,
  adminPlatformAgentAssignmentUpsertInputSchema,
  adminPlatformAgentDependentsOutputSchema,
  adminPlatformAgentDetailOutputSchema,
  adminPlatformAgentGetInputSchema,
  adminPlatformAgentListInputSchema,
  adminPlatformAgentListOutputSchema,
  adminPlatformAgentPublishInputSchema,
  adminPlatformAgentRolloutCancelInputSchema,
  adminPlatformAgentRolloutListOutputSchema,
  adminPlatformAgentRolloutRetryInputSchema,
  adminPlatformAgentRolloutRollbackInputSchema,
  adminPlatformAgentRolloutStartInputSchema,
  adminPlatformAgentSetDefaultInboxInputSchema,
  adminPlatformAgentUpdateDraftInputSchema,
  adminPlatformAgentVersionsListOutputSchema,
  platformAgentAssignmentSchema,
  platformAgentDependencySnapshotSchema,
  platformAgentEffectiveListOutputSchema,
  platformAgentIdentityDraftSchema,
  platformAgentImmutableVersionSchema,
  platformAgentRolloutProjectionSchema,
} from './platformAgents';

const checksum = 'a'.repeat(64);

const config = {
  avatar: null,
  backgroundColor: '#112233',
  description: 'Helps with internal search',
  displayName: 'Research Agent',
  modelParameters: { maxTokens: 4096, temperature: 0.5 },
  openingMessage: 'What should we research?',
  openingQuestions: ['Summarize this topic'],
  systemRole: 'Use only approved sources.',
  tags: ['research'],
};

const dependencySnapshot = {
  connectors: [
    {
      allowedToolKeys: ['search.query'],
      connectorId: 'connector-id',
      connectorKey: 'internal.search',
      publishedChecksum: checksum,
      publishedRevision: 3,
    },
  ],
  model: {
    modelKey: 'gpt-enterprise',
    providerChecksum: checksum,
    providerKey: 'openai-enterprise',
    providerRevision: 7,
  },
  skills: [{ checksum, skillKey: 'research', version: '1.0.0' }],
};

const draft = {
  agentKey: 'research',
  currentVersionId: 'version-id',
  draftSequence: 2,
  id: 'agent-id',
  isDefault: false,
  migrationRequired: false,
  revision: 1,
  status: 'published' as const,
  systemKey: null,
};

const version = {
  agentId: 'agent-id',
  checksum,
  config,
  createdAt: new Date('2026-07-17T00:00:00Z'),
  createdBy: 'admin-id',
  dependencySnapshot,
  id: 'version-id',
  version: '1.0.0',
};

const assignment = {
  agentId: 'agent-id',
  enabled: true,
  id: 'assignment-id',
  mode: 'mandatory' as const,
  pinnedVersionId: null,
  targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
  targetType: 'global' as const,
  versionPolicy: 'latest_published' as const,
};

const rollout = {
  assignmentId: 'assignment-id',
  completed: 9,
  cursor: 'user-cursor',
  failed: 1,
  jobId: 'job-id',
  previousVersionId: 'version-0',
  revision: 2,
  status: 'dead' as const,
  targetVersionId: 'version-1',
  total: 10,
  updatedAt: new Date('2026-07-17T00:00:00Z'),
};

describe('platform Agent contracts', () => {
  it('accepts exact secret-free dependency revisions and rejects loose or duplicate refs', () => {
    expect(platformAgentDependencySnapshotSchema.parse(dependencySnapshot)).toEqual(
      dependencySnapshot,
    );
    expect(
      platformAgentDependencySnapshotSchema.safeParse({
        ...dependencySnapshot,
        connectors: [...dependencySnapshot.connectors, ...dependencySnapshot.connectors],
      }).success,
    ).toBe(false);
    expect(
      platformAgentDependencySnapshotSchema.safeParse({
        ...dependencySnapshot,
        model: { modelKey: 'gpt-enterprise', providerKey: 'openai-enterprise' },
      }).success,
    ).toBe(false);
    expect(
      platformAgentDependencySnapshotSchema.safeParse({
        ...dependencySnapshot,
        token: 'should-never-be-accepted',
      }).success,
    ).toBe(false);
  });

  it('rejects secret material and client-supplied immutable checksum fields', () => {
    const input = {
      agentId: 'agent-id',
      config,
      dependencySnapshot,
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 0,
      reason: 'create reviewed version',
      version: '1.0.0',
    };
    expect(adminPlatformAgentAppendVersionInputSchema.safeParse(input).success).toBe(true);
    expect(
      adminPlatformAgentAppendVersionInputSchema.safeParse({ ...input, checksum }).success,
    ).toBe(false);
    expect(
      adminPlatformAgentAppendVersionInputSchema.safeParse({
        ...input,
        config: { ...config, systemRole: 'Authorization: Bearer a-secret-token-value' },
      }).success,
    ).toBe(false);
  });

  it('keeps immutable versions strict and complete', () => {
    expect(platformAgentImmutableVersionSchema.safeParse(version).success).toBe(true);
    expect(
      platformAgentImmutableVersionSchema.safeParse({ ...version, encryptedCredentials: 'x' })
        .success,
    ).toBe(false);
  });

  it('requires the default inbox identity and published pointer to agree', () => {
    const draft = {
      agentKey: 'default-inbox',
      currentVersionId: 'version-id',
      draftSequence: 1,
      id: 'agent-id',
      isDefault: true,
      migrationRequired: false,
      revision: 1,
      status: 'published' as const,
      systemKey: 'default-inbox' as const,
    };
    expect(platformAgentIdentityDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      platformAgentIdentityDraftSchema.safeParse({ ...draft, currentVersionId: null }).success,
    ).toBe(false);
    expect(platformAgentIdentityDraftSchema.safeParse({ ...draft, systemKey: null }).success).toBe(
      false,
    );
  });

  it('uses a fixed global sentinel and same-Agent pinned-version shape', () => {
    const global = {
      agentId: 'agent-id',
      enabled: true,
      id: 'assignment-id',
      mode: 'mandatory' as const,
      pinnedVersionId: null,
      targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
      targetType: 'global' as const,
      versionPolicy: 'latest_published' as const,
    };
    expect(platformAgentAssignmentSchema.safeParse(global).success).toBe(true);
    expect(
      platformAgentAssignmentSchema.safeParse({ ...global, targetId: 'different' }).success,
    ).toBe(false);
    expect(
      platformAgentAssignmentSchema.safeParse({
        ...global,
        pinnedVersionId: 'version-id',
      }).success,
    ).toBe(false);
  });

  it('does not expose assignment targets, reasons, or internal dependency ids publicly', () => {
    const output = {
      agents: [
        {
          agentKey: 'research',
          checksum,
          config,
          distribution: 'default',
          mutable: false,
          platformAgentId: 'agent-id',
          source: 'platform',
          systemKey: null,
          version: '1.0.0',
          versionId: 'version-id',
        },
      ],
      revision: checksum,
    };
    expect(platformAgentEffectiveListOutputSchema.safeParse(output).success).toBe(true);
    expect(
      platformAgentEffectiveListOutputSchema.safeParse({
        ...output,
        agents: [
          {
            ...output.agents[0],
            dependencySnapshot,
            reason: 'admin-only',
            targetId: 'user-id',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('preserves the terminal dead rollout state', () => {
    expect(platformAgentRolloutProjectionSchema.safeParse(rollout).success).toBe(true);
  });

  it('defines strict list, get and detail endpoint projections', () => {
    expect(adminPlatformAgentListInputSchema.safeParse({ query: 'research' }).success).toBe(true);
    expect(adminPlatformAgentListInputSchema.safeParse({ isDefault: true, limit: 1 }).success).toBe(
      true,
    );
    expect(
      adminPlatformAgentListInputSchema.safeParse({ poison: true, query: 'research' }).success,
    ).toBe(false);
    expect(adminPlatformAgentGetInputSchema.safeParse({ id: 'agent-id' }).success).toBe(true);
    expect(
      adminPlatformAgentListOutputSchema.safeParse({
        items: [
          {
            assignmentCount: 1,
            displayName: 'Research Agent',
            identity: draft,
            publishedVersion: '1.0.0',
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentDetailOutputSchema.safeParse({
        draftToken: 'b'.repeat(64),
        identity: draft,
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentDetailOutputSchema.safeParse({
        assignments: [assignment],
        draftToken: 'b'.repeat(64),
        identity: draft,
      }).success,
    ).toBe(false);
    expect(
      adminPlatformAgentVersionsListOutputSchema.safeParse({
        items: [version],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentAssignmentListOutputSchema.safeParse({
        items: [assignment],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentRolloutListOutputSchema.safeParse({
        items: [rollout],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it('requires CAS, atomic default fields and explicit archive replacement', () => {
    const base = {
      agentId: 'agent-id',
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 1,
      reason: 'approved change',
    };
    expect(adminPlatformAgentUpdateDraftInputSchema.safeParse(base).success).toBe(false);
    expect(
      adminPlatformAgentUpdateDraftInputSchema.safeParse({ ...base, isDefault: false }).success,
    ).toBe(false);
    expect(
      adminPlatformAgentUpdateDraftInputSchema.safeParse({ ...base, systemKey: null }).success,
    ).toBe(false);
    expect(
      adminPlatformAgentUpdateDraftInputSchema.safeParse({
        ...base,
        isDefault: false,
        systemKey: null,
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentUpdateDraftInputSchema.safeParse({
        ...base,
        isDefault: true,
        systemKey: null,
      }).success,
    ).toBe(false);
    expect(adminPlatformAgentArchiveInputSchema.safeParse(base).success).toBe(false);
    expect(
      adminPlatformAgentArchiveInputSchema.safeParse({ ...base, replacementAgentId: null }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentArchiveInputSchema.safeParse({
        ...base,
        reason: '',
        replacementAgentId: null,
      }).success,
    ).toBe(false);
  });

  it('publishes an existing immutable version and switches the default atomically', () => {
    const pointer = {
      agentId: 'agent-id',
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 1,
    };
    expect(
      adminPlatformAgentPublishInputSchema.safeParse({
        ...pointer,
        reason: 'publish reviewed version',
        versionId: 'version-id',
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentPublishInputSchema.safeParse({
        ...pointer,
        config,
        reason: 'publish reviewed version',
        versionId: 'version-id',
      }).success,
    ).toBe(false);
    expect(
      adminPlatformAgentSetDefaultInboxInputSchema.safeParse({
        currentDefault: { ...pointer, agentId: 'old-agent-id' },
        nextDefault: pointer,
        reason: 'replace default inbox',
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentSetDefaultInboxInputSchema.safeParse({
        currentDefault: pointer,
        nextDefault: pointer,
        reason: 'replace default inbox',
      }).success,
    ).toBe(false);
  });

  it('keeps assignment upsert, preview, and output target/version invariants identical', () => {
    const write = {
      agentId: 'agent-id',
      enabled: true,
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 1,
      mode: 'optional' as const,
      pinnedVersionId: null,
      reason: 'assign cohort',
      targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
      targetType: 'global' as const,
      versionPolicy: 'latest_published' as const,
    };
    const {
      agentId: _,
      expectedDraftToken: __,
      expectedRevision: ___,
      reason: ____,
      ...core
    } = write;

    const parseUpsert = (value: unknown) =>
      adminPlatformAgentAssignmentUpsertInputSchema.safeParse(value).success;
    const parsePreview = (assignment: unknown) =>
      adminPlatformAgentAssignmentPreviewInputSchema.safeParse({
        agentId: 'agent-id',
        assignment,
      }).success;
    const parseOutput = (assignment: unknown) =>
      platformAgentAssignmentSchema.safeParse({
        agentId: 'agent-id',
        id: 'assignment-id',
        ...(assignment as object),
      }).success;

    // Valid global + latest_published on every derived schema.
    expect(parseUpsert(write)).toBe(true);
    expect(parsePreview(core)).toBe(true);
    expect(parseOutput(core)).toBe(true);

    // Invalid global target pairing rejected identically.
    expect(parseUpsert({ ...write, targetId: 'not-global' })).toBe(false);
    expect(parsePreview({ ...core, targetId: 'not-global' })).toBe(false);
    expect(parseOutput({ ...core, targetId: 'not-global' })).toBe(false);
    expect(parseUpsert({ ...write, targetId: 'user-1', targetType: 'global' })).toBe(false);
    expect(
      parsePreview({ ...core, targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID, targetType: 'user' }),
    ).toBe(false);
    expect(
      parseOutput({ ...core, targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID, targetType: 'user' }),
    ).toBe(false);

    // Pinned policy requires a version id on every derived schema.
    const pinned = {
      ...core,
      pinnedVersionId: 'version-id',
      versionPolicy: 'pinned' as const,
    };
    expect(parseUpsert({ ...write, ...pinned })).toBe(true);
    expect(parsePreview(pinned)).toBe(true);
    expect(parseOutput(pinned)).toBe(true);

    const pinnedWithoutVersion = {
      ...core,
      pinnedVersionId: null,
      versionPolicy: 'pinned' as const,
    };
    expect(parseUpsert({ ...write, ...pinnedWithoutVersion })).toBe(false);
    expect(parsePreview(pinnedWithoutVersion)).toBe(false);
    expect(parseOutput(pinnedWithoutVersion)).toBe(false);

    const unpinnedWithVersion = {
      ...core,
      pinnedVersionId: 'version-id',
      versionPolicy: 'latest_published' as const,
    };
    expect(parseUpsert({ ...write, ...unpinnedWithVersion })).toBe(false);
    expect(parsePreview(unpinnedWithVersion)).toBe(false);
    expect(parseOutput(unpinnedWithVersion)).toBe(false);

    expect(
      adminPlatformAgentAssignmentRemoveInputSchema.safeParse({
        agentId: 'agent-id',
        assignmentId: 'assignment-id',
        expectedDraftToken: 'b'.repeat(64),
        expectedRevision: 1,
        reason: 'remove cohort',
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentAssignmentRemoveInputSchema.safeParse({
        agentId: 'agent-id',
        assignmentId: 'assignment-id',
        reason: 'remove cohort',
      }).success,
    ).toBe(false);
  });

  it('accepts SemVer build metadata on platform agent versions', () => {
    expect(
      platformAgentImmutableVersionSchema.safeParse({ ...version, version: '2.4.0+corp.17' })
        .success,
    ).toBe(true);
    expect(
      platformAgentImmutableVersionSchema.safeParse({ ...version, version: '1.2.3+build.5' })
        .success,
    ).toBe(true);
    expect(
      platformAgentImmutableVersionSchema.safeParse({ ...version, version: 'v2.4.0' }).success,
    ).toBe(false);
  });

  it('gates rollout mutations with Agent and job CAS and operation-specific statuses', () => {
    expect(
      adminPlatformAgentRolloutStartInputSchema.safeParse({
        agentId: 'agent-id',
        assignmentId: 'assignment-id',
        expectedDraftToken: 'b'.repeat(64),
        expectedRevision: 1,
        reason: 'start rollout',
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentRolloutStartInputSchema.safeParse({
        agentId: 'agent-id',
        assignmentId: 'assignment-id',
        reason: 'start rollout',
      }).success,
    ).toBe(false);
    expect(
      adminPlatformAgentRolloutCancelInputSchema.safeParse({
        agentId: 'agent-id',
        jobId: 'job-id',
      }).success,
    ).toBe(false);

    const cancelBase = {
      agentId: 'agent-id',
      expectedJobRevision: 2,
      jobId: 'job-id',
      reason: 'stop rollout',
    };
    for (const expectedStatus of ['pending', 'running'] as const) {
      expect(
        adminPlatformAgentRolloutCancelInputSchema.safeParse({ ...cancelBase, expectedStatus })
          .success,
      ).toBe(true);
    }
    for (const expectedStatus of ['cancelled', 'completed', 'dead', 'failed'] as const) {
      expect(
        adminPlatformAgentRolloutCancelInputSchema.safeParse({ ...cancelBase, expectedStatus })
          .success,
      ).toBe(false);
    }

    const retryBase = {
      agentId: 'agent-id',
      expectedJobRevision: 2,
      jobId: 'job-id',
      reason: 'retry rollout',
    };
    for (const expectedStatus of ['cancelled', 'dead', 'failed'] as const) {
      expect(
        adminPlatformAgentRolloutRetryInputSchema.safeParse({ ...retryBase, expectedStatus })
          .success,
      ).toBe(true);
    }
    for (const expectedStatus of ['pending', 'running', 'completed'] as const) {
      expect(
        adminPlatformAgentRolloutRetryInputSchema.safeParse({ ...retryBase, expectedStatus })
          .success,
      ).toBe(false);
    }

    const rollbackBase = {
      agentId: 'agent-id',
      expectedJobRevision: 2,
      jobId: 'job-id',
      reason: 'compensate rollout',
      targetVersionId: 'version-id',
    };
    expect(
      adminPlatformAgentRolloutRollbackInputSchema.safeParse({
        ...rollbackBase,
        expectedStatus: 'completed',
      }).success,
    ).toBe(true);
    for (const expectedStatus of ['pending', 'running', 'cancelled', 'dead', 'failed'] as const) {
      expect(
        adminPlatformAgentRolloutRollbackInputSchema.safeParse({
          ...rollbackBase,
          expectedStatus,
        }).success,
      ).toBe(false);
    }
  });

  it('bounds and redacts dependent endpoint output', () => {
    expect(
      adminPlatformAgentDependentsOutputSchema.safeParse({
        items: [
          {
            id: 'assignment-id',
            key: 'global',
            name: 'All users',
            type: 'assignment',
            version: '1.0.0',
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentDependentsOutputSchema.safeParse({
        items: [{ secret: 'token', type: 'assignment' }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});
