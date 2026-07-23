import { describe, expect, it } from 'vitest';

import { createMockAdminAgentsClient } from './mockAdminAgents';

describe('mock Admin Agents contract adapter', () => {
  it('filters the catalog and exposes terminal rollout states through the paged endpoint', async () => {
    const client = createMockAdminAgentsClient();
    const list = await client.list({ query: 'research', status: 'draft' });
    expect(list.items.map(({ identity }) => identity.id)).toEqual(['agent-research']);
    const rollouts = await client.listRollouts({ agentId: 'agent-research' });
    expect(rollouts.items[0]?.status).toBe('dead');
    expect(rollouts.nextCursor).toBeNull();
  });

  it('rejects stale version writes with revision and draft-token CAS', async () => {
    const client = createMockAdminAgentsClient();
    const detail = await client.get({ id: 'agent-inbox' });
    const version = (await client.listVersions({ agentId: detail.identity.id })).items[0]!;
    await expect(
      client.appendVersion({
        agentId: detail.identity.id,
        config: version.config,
        dependencySnapshot: version.dependencySnapshot,
        expectedDraftToken: 'f'.repeat(64),
        expectedRevision: detail.identity.revision,
        reason: 'stale write test',
        version: '1.0.1',
      }),
    ).rejects.toThrow('PLATFORM_AGENT_CONFLICT');
  });

  it('covers create, immutable version, publication, rollback, and assignment CAS', async () => {
    const client = createMockAdminAgentsClient();
    const created = await client.create({
      agentKey: 'support-agent',
      isDefault: false,
      reason: 'create support draft',
      systemKey: null,
    });
    expect((await client.listVersions({ agentId: created.identity.id })).items).toHaveLength(0);

    const source = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    const appended = await client.appendVersion({
      agentId: created.identity.id,
      config: { ...source.config, displayName: 'Support Agent' },
      dependencySnapshot: source.dependencySnapshot,
      expectedDraftToken: created.draftToken,
      expectedRevision: created.identity.revision,
      reason: 'add first exact version',
      version: '1.0.0',
    });
    const published = await client.publish({
      agentId: created.identity.id,
      expectedDraftToken: appended.draftToken,
      expectedRevision: appended.identity.revision,
      reason: 'publish support',
      versionId: appended.version.id,
    });
    expect(published.versionId).toBe(appended.version.id);

    let detail = await client.get({ id: created.identity.id });
    const assignment = await client.upsertAssignment({
      agentId: created.identity.id,
      enabled: true,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.identity.revision,
      mode: 'optional',
      pinnedVersionId: null,
      reason: 'optional pilot',
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });
    expect((await client.listAssignments({ agentId: created.identity.id })).items).toHaveLength(1);

    detail = await client.get({ id: created.identity.id });
    await client.removeAssignment({
      agentId: created.identity.id,
      assignmentId: assignment.id,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.identity.revision,
      reason: 'end pilot',
    });
    expect((await client.listAssignments({ agentId: created.identity.id })).items).toHaveLength(0);

    detail = await client.get({ id: created.identity.id });
    const rolledBack = await client.rollback({
      agentId: created.identity.id,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.identity.revision,
      reason: 'exercise rollback pointer',
      targetVersionId: appended.version.id,
    });
    expect(rolledBack.versionId).toBe(appended.version.id);
  });

  it('enforces job revision/status CAS across rollout transitions', async () => {
    const client = createMockAdminAgentsClient();
    const detail = await client.get({ id: 'agent-inbox' });
    const started = await client.startRollout({
      agentId: 'agent-inbox',
      assignmentId: 'assignment-inbox-global',
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.identity.revision,
      reason: 'exercise rollout',
    });
    expect(started.status).toBe('pending');
    const cancelled = await client.cancelRollout({
      agentId: 'agent-inbox',
      expectedJobRevision: started.revision,
      expectedStatus: started.status,
      jobId: started.jobId,
      reason: 'pause rollout',
    });
    expect(cancelled.status).toBe('cancelled');
    await expect(
      client.retryRollout({
        agentId: 'agent-inbox',
        expectedJobRevision: started.revision,
        expectedStatus: started.status,
        jobId: started.jobId,
        reason: 'stale retry',
      }),
    ).rejects.toThrow('PLATFORM_AGENT_ROLLOUT_CONFLICT');
    const retried = await client.retryRollout({
      agentId: 'agent-inbox',
      expectedJobRevision: cancelled.revision,
      expectedStatus: cancelled.status,
      jobId: cancelled.jobId,
      reason: 'retry rollout',
    });
    expect(retried.status).toBe('pending');
  });

  it('switches the default Inbox atomically and requires an archive replacement', async () => {
    const client = createMockAdminAgentsClient();
    const current = await client.get({ id: 'agent-inbox' });
    const nextDraft = await client.get({ id: 'agent-research' });
    const nextVersion = (await client.listVersions({ agentId: nextDraft.identity.id })).items[0]!;
    await client.publish({
      agentId: nextDraft.identity.id,
      expectedDraftToken: nextDraft.draftToken,
      expectedRevision: nextDraft.identity.revision,
      reason: 'publish replacement',
      versionId: nextVersion.id,
    });
    const next = await client.get({ id: nextDraft.identity.id });

    await expect(
      client.archive({
        agentId: current.identity.id,
        expectedDraftToken: current.draftToken,
        expectedRevision: current.identity.revision,
        reason: 'unsafe archive',
        replacementAgentId: null,
      }),
    ).rejects.toThrow('PLATFORM_AGENT_DEFAULT_REPLACEMENT_REQUIRED');

    const switched = await client.setDefaultInbox({
      currentDefault: {
        agentId: current.identity.id,
        expectedDraftToken: current.draftToken,
        expectedRevision: current.identity.revision,
      },
      nextDefault: {
        agentId: next.identity.id,
        expectedDraftToken: next.draftToken,
        expectedRevision: next.identity.revision,
      },
      reason: 'promote research default',
    });

    expect(switched.currentDefault?.identity.isDefault).toBe(false);
    expect(switched.nextDefault.identity).toMatchObject({
      isDefault: true,
      systemKey: 'default-inbox',
    });
  });
});
