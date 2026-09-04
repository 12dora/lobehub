import { PLATFORM_AGENT_GLOBAL_TARGET_ID } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { ADMIN_MUTATION_REGISTRY } from '../security/policy/adminMutationRegistry';
import {
  adminPlatformAgentArchiveInputSchema,
  adminPlatformAgentAssignmentListOutputSchema,
  adminPlatformAgentAssignmentPreviewInputSchema,
  adminPlatformAgentAssignmentRemoveInputSchema,
  adminPlatformAgentAssignmentUpsertInputSchema,
  adminPlatformAgentCreateInputSchema,
  adminPlatformAgentDeleteInputSchema,
  adminPlatformAgentDependentsOutputSchema,
  adminPlatformAgentDetailOutputSchema,
  adminPlatformAgentGetInputSchema,
  adminPlatformAgentListInputSchema,
  adminPlatformAgentListOutputSchema,
  adminPlatformAgentProvisionDefaultInboxInputSchema,
  adminPlatformAgentRollbackInputSchema,
  adminPlatformAgentRolloutCancelInputSchema,
  adminPlatformAgentRolloutListOutputSchema,
  adminPlatformAgentRolloutRetryInputSchema,
  adminPlatformAgentRolloutRollbackInputSchema,
  adminPlatformAgentRolloutStartInputSchema,
  adminPlatformAgentSaveInputSchema,
  adminPlatformAgentSaveOutputSchema,
  adminPlatformAgentSetDefaultInboxInputSchema,
  adminPlatformAgentVersionsListOutputSchema,
  platformAgentAssignmentSchema,
  platformAgentDependencySnapshotSchema,
  platformAgentEffectiveListOutputSchema,
  platformAgentIdentityDraftSchema,
  platformAgentImmutableVersionSchema,
  platformAgentRolloutProjectionSchema,
  platformAgentVersionConfigSchema,
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

  it('rejects secret material, client-supplied checksums and client-chosen version labels', () => {
    const input = {
      agentId: 'agent-id',
      config,
      dependencySnapshot,
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 0,
      reason: 'save reviewed change',
    };
    expect(adminPlatformAgentSaveInputSchema.safeParse(input).success).toBe(true);
    expect(adminPlatformAgentSaveInputSchema.safeParse({ ...input, checksum }).success).toBe(false);
    // The version label is server-generated — clients may not propose one.
    expect(
      adminPlatformAgentSaveInputSchema.safeParse({ ...input, version: '2.0.0' }).success,
    ).toBe(false);
    expect(
      adminPlatformAgentSaveInputSchema.safeParse({
        ...input,
        config: { ...config, systemRole: 'Authorization: Bearer a-secret-token-value' },
      }).success,
    ).toBe(false);
  });

  it('creates and publishes in one payload and returns the published identity + version', () => {
    const createInput = {
      agentKey: 'research',
      config,
      dependencySnapshot,
      reason: 'create research agent',
    };
    expect(adminPlatformAgentCreateInputSchema.safeParse(createInput)).toMatchObject({
      data: { isDefault: false, systemKey: null },
      success: true,
    });
    // A created Agent can never seed the default-inbox singleton through this contract.
    expect(
      adminPlatformAgentCreateInputSchema.safeParse({ ...createInput, isDefault: true }).success,
    ).toBe(false);
    // Config / dependencies are mandatory now that create publishes.
    expect(
      adminPlatformAgentCreateInputSchema.safeParse({
        agentKey: 'research',
        reason: 'create without config',
      }).success,
    ).toBe(false);

    const output = {
      draftToken: 'b'.repeat(64),
      identity: { ...draft, revision: 1 },
      invalidationStatus: 'delivered' as const,
      version,
    };
    expect(adminPlatformAgentSaveOutputSchema.safeParse(output).success).toBe(true);
    // A published save output must carry a version pointer on the identity.
    expect(
      adminPlatformAgentSaveOutputSchema.safeParse({
        ...output,
        identity: { ...output.identity, currentVersionId: null },
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

  it('allows an empty systemRole and still bounds its length', () => {
    const emptyRole = { ...config, systemRole: '' };
    expect(platformAgentVersionConfigSchema.safeParse(emptyRole).success).toBe(true);
    expect(
      platformAgentImmutableVersionSchema.safeParse({ ...version, config: emptyRole }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentSaveInputSchema.safeParse({
        agentId: 'agent-id',
        config: emptyRole,
        dependencySnapshot,
        expectedDraftToken: 'b'.repeat(64),
        expectedRevision: 0,
      }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentVersionsListOutputSchema.safeParse({
        items: [{ ...version, config: emptyRole }],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      platformAgentVersionConfigSchema.safeParse({ ...config, systemRole: 'x'.repeat(100_001) })
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

  it('accepts an omitted or locale-only provisionDefaultInbox payload', () => {
    expect(adminPlatformAgentProvisionDefaultInboxInputSchema.safeParse(undefined).success).toBe(
      true,
    );
    expect(adminPlatformAgentProvisionDefaultInboxInputSchema.safeParse({}).success).toBe(true);
    expect(
      adminPlatformAgentProvisionDefaultInboxInputSchema.safeParse({ locale: 'zh-CN' }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentProvisionDefaultInboxInputSchema.safeParse({ locale: 'zh-CN', extra: 1 })
        .success,
    ).toBe(false);
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
    // save carries the full payload behind the identity CAS; the default flag is not a save
    // concern at all (setDefaultInbox / archive own the singleton).
    expect(adminPlatformAgentSaveInputSchema.safeParse(base).success).toBe(false);
    expect(
      adminPlatformAgentSaveInputSchema.safeParse({ ...base, config, dependencySnapshot }).success,
    ).toBe(true);
    expect(
      adminPlatformAgentSaveInputSchema.safeParse({
        ...base,
        config,
        dependencySnapshot,
        isDefault: false,
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

  it('switches the default atomically', () => {
    const pointer = {
      agentId: 'agent-id',
      expectedDraftToken: 'b'.repeat(64),
      expectedRevision: 1,
    };
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

    // Pinned policy requires a version id on every derived schema. Write schemas then
    // canonicalize to latest_published; output still round-trips legacy pinned rows.
    const pinned = {
      ...core,
      pinnedVersionId: 'version-id',
      versionPolicy: 'pinned' as const,
    };
    expect(parseUpsert({ ...write, ...pinned })).toBe(true);
    expect(parsePreview(pinned)).toBe(true);
    expect(parseOutput(pinned)).toBe(true);
    expect(
      adminPlatformAgentAssignmentUpsertInputSchema.parse({ ...write, ...pinned }),
    ).toMatchObject({
      pinnedVersionId: null,
      versionPolicy: 'latest_published',
    });
    expect(
      adminPlatformAgentAssignmentPreviewInputSchema.parse({
        agentId: 'agent-id',
        assignment: pinned,
      }).assignment,
    ).toMatchObject({
      pinnedVersionId: null,
      versionPolicy: 'latest_published',
    });
    expect(
      platformAgentAssignmentSchema.parse({
        agentId: 'agent-id',
        id: 'assignment-id',
        ...pinned,
      }),
    ).toMatchObject({
      pinnedVersionId: 'version-id',
      versionPolicy: 'pinned',
    });

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

/**
 * The mutation registry states, per procedure, whether an audit reason is mandatory. That claim is
 * only honest while it matches what the input contract actually accepts, so assert both directions
 * on a payload that is complete except for the reason.
 */
describe('Agent catalog reason contracts match the mutation registry', () => {
  const cas = { expectedDraftToken: checksum, expectedRevision: 4 };
  const pointer = { agentId: 'agent-id', ...cas };

  it.each([
    [
      'admin.agents.create',
      adminPlatformAgentCreateInputSchema,
      { agentKey: 'research', config, dependencySnapshot, isDefault: false, systemKey: null },
    ],
    [
      'admin.agents.save',
      adminPlatformAgentSaveInputSchema,
      { ...pointer, config, dependencySnapshot },
    ],
    [
      'admin.agents.rollback',
      adminPlatformAgentRollbackInputSchema,
      { ...pointer, targetVersionId: 'version-id' },
    ],
    [
      'admin.agents.setDefaultInbox',
      adminPlatformAgentSetDefaultInboxInputSchema,
      { currentDefault: null, nextDefault: pointer },
    ],
    [
      'admin.agents.assignments.upsert',
      adminPlatformAgentAssignmentUpsertInputSchema,
      {
        ...pointer,
        enabled: true,
        mode: 'optional',
        pinnedVersionId: null,
        targetId: PLATFORM_AGENT_GLOBAL_TARGET_ID,
        targetType: 'global',
        versionPolicy: 'latest_published',
      },
    ],
    [
      'admin.agents.assignments.remove',
      adminPlatformAgentAssignmentRemoveInputSchema,
      { ...pointer, assignmentId: 'assignment-id' },
    ],
    [
      'admin.agents.rollouts.start',
      adminPlatformAgentRolloutStartInputSchema,
      { ...pointer, assignmentId: 'assignment-id' },
    ],
    [
      'admin.agents.rollouts.cancel',
      adminPlatformAgentRolloutCancelInputSchema,
      { agentId: 'agent-id', expectedJobRevision: 1, expectedStatus: 'running', jobId: 'job-id' },
    ],
    [
      'admin.agents.archive',
      adminPlatformAgentArchiveInputSchema,
      { ...pointer, replacementAgentId: null },
    ],
    ['admin.agents.delete', adminPlatformAgentDeleteInputSchema, pointer],
  ])(
    '%s accepts an omitted reason exactly when the registry says it is optional',
    (procedure, schema, payloadWithoutReason) => {
      const control =
        ADMIN_MUTATION_REGISTRY[procedure as keyof typeof ADMIN_MUTATION_REGISTRY].controls.reason;
      // 'conditional' is the optional-reason declaration; 'enforced' means the contract must reject.
      expect(['conditional', 'enforced']).toContain(control.status);
      expect(schema.safeParse(payloadWithoutReason).success).toBe(control.status === 'conditional');
      // A supplied reason is always accepted and always bounded (whitespace-only is never a reason).
      expect(schema.safeParse({ ...payloadWithoutReason, reason: 'operator note' }).success).toBe(
        true,
      );
      expect(schema.safeParse({ ...payloadWithoutReason, reason: '   ' }).success).toBe(false);
    },
  );
});
