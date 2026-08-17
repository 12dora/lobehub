import { describe, expect, it } from 'vitest';

import { createMockAdminAgentsClient } from './mockAdminAgents';

/**
 * Long enough that a char-code hex stream of `agentKey` alone exceeds 64 hex chars (32 source
 * chars), so a truncated mock digest would ignore later identity fields — still within the
 * schema max of 128.
 */
const LONG_AGENT_KEY = `long-key-${'k'.repeat(40)}`;

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
      client.save({
        agentId: detail.identity.id,
        config: version.config,
        dependencySnapshot: version.dependencySnapshot,
        expectedDraftToken: 'f'.repeat(64),
        expectedRevision: detail.identity.revision,
        reason: 'stale write test',
      }),
    ).rejects.toThrow('PLATFORM_AGENT_CONFLICT');
  });

  it('publishes on create, bumps the version on save, and keeps assignment/rollback CAS', async () => {
    const client = createMockAdminAgentsClient();
    const source = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    const created = await client.create({
      agentKey: 'support-agent',
      config: { ...source.config, displayName: 'Support Agent' },
      dependencySnapshot: source.dependencySnapshot,
      isDefault: false,
      reason: 'create support assistant',
      systemKey: null,
    });
    // Create appends the first version AND publishes it in one transaction.
    expect(created.identity.status).toBe('published');
    expect(created.version.version).toBe('1.0.0');
    expect(created.identity.currentVersionId).toBe(created.version.id);
    expect((await client.listVersions({ agentId: created.identity.id })).items).toHaveLength(1);

    const saved = await client.save({
      agentId: created.identity.id,
      config: { ...source.config, displayName: 'Support Agent v2' },
      dependencySnapshot: source.dependencySnapshot,
      expectedDraftToken: created.draftToken,
      expectedRevision: created.identity.revision,
      reason: 'refine the role',
    });
    // The label is server-generated (patch bump) and the new version is live immediately.
    expect(saved.version.version).toBe('1.0.1');
    expect(saved.identity.status).toBe('published');
    expect(saved.identity.currentVersionId).toBe(saved.version.id);
    expect(saved.identity.revision).toBe(created.identity.revision + 1);
    expect(saved.draftToken).not.toBe(created.draftToken);

    let detail = await client.get({ id: created.identity.id });
    const publishedRevision = detail.identity.revision;
    const publishedDraftSequence = detail.identity.draftSequence;
    const upserted = await client.upsertAssignment({
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
    // Assignment CAS matches production: draftSequence + token only (F1/F4).
    expect(detail.identity.revision).toBe(publishedRevision);
    expect(detail.identity.draftSequence).toBe(publishedDraftSequence + 1);
    expect(detail.draftToken).not.toBe(saved.draftToken);
    // The write already handed back that same advanced CAS — a chained write needs no re-GET.
    expect(upserted.draftToken).toBe(detail.draftToken);
    expect(upserted.identity.draftSequence).toBe(detail.identity.draftSequence);

    const removed = await client.removeAssignment({
      agentId: created.identity.id,
      assignmentId: upserted.assignment.id,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.identity.revision,
      reason: 'end pilot',
    });
    expect((await client.listAssignments({ agentId: created.identity.id })).items).toHaveLength(0);

    detail = await client.get({ id: created.identity.id });
    expect(detail.identity.revision).toBe(publishedRevision);
    expect(detail.identity.draftSequence).toBe(publishedDraftSequence + 2);
    expect(removed.draftToken).toBe(detail.draftToken);

    const rolledBack = await client.rollback({
      agentId: created.identity.id,
      expectedDraftToken: detail.draftToken,
      expectedRevision: detail.identity.revision,
      reason: 'exercise rollback pointer',
      targetVersionId: created.version.id,
    });
    expect(rolledBack.versionId).toBe(created.version.id);
    expect(rolledBack.revision).toBe(publishedRevision + 1);
  });

  it('draft-only writes change draftToken for long agent keys (full identity digest, F4)', async () => {
    const client = createMockAdminAgentsClient();
    const source = (await client.listVersions({ agentId: 'agent-inbox' })).items[0]!;
    const created = await client.create({
      agentKey: LONG_AGENT_KEY,
      config: source.config,
      dependencySnapshot: source.dependencySnapshot,
      isDefault: false,
      reason: 'long-key draft token',
      systemKey: null,
    });
    const tokenBefore = created.draftToken;
    const revisionBefore = created.identity.revision;
    const sequenceBefore = created.identity.draftSequence;
    expect(tokenBefore).toMatch(/^[a-f0-9]{64}$/);

    // Assignment CAS is draftSequence-only in production; the mock must advance the token too.
    await client.upsertAssignment({
      agentId: created.identity.id,
      enabled: true,
      expectedDraftToken: tokenBefore,
      expectedRevision: revisionBefore,
      mode: 'optional',
      pinnedVersionId: null,
      reason: 'long-key assignment',
      targetId: '__global__',
      targetType: 'global',
      versionPolicy: 'latest_published',
    });

    const afterAssignment = await client.get({ id: created.identity.id });
    expect(afterAssignment.identity.revision).toBe(revisionBefore);
    expect(afterAssignment.identity.draftSequence).toBe(sequenceBefore + 1);
    // Truncating the identity hex to 64 chars would leave this token unchanged for long keys.
    expect(afterAssignment.draftToken).not.toBe(tokenBefore);
    expect(afterAssignment.draftToken).toMatch(/^[a-f0-9]{64}$/);

    const tokenMid = afterAssignment.draftToken;
    // A second draft-only write (remove) must also re-digest the full identity, not a 64-char prefix.
    const listed = await client.listAssignments({ agentId: created.identity.id });
    await client.removeAssignment({
      agentId: created.identity.id,
      assignmentId: listed.items[0]!.id,
      expectedDraftToken: tokenMid,
      expectedRevision: revisionBefore,
      reason: 'long-key assignment remove',
    });
    const afterRemove = await client.get({ id: created.identity.id });
    expect(afterRemove.identity.revision).toBe(revisionBefore);
    expect(afterRemove.identity.draftSequence).toBe(sequenceBefore + 2);
    expect(afterRemove.draftToken).not.toBe(tokenMid);
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
      // Narrowed contract: cancel only accepts active statuses.
      expectedStatus: 'pending',
      jobId: started.jobId,
      reason: 'pause rollout',
    });
    expect(cancelled.status).toBe('cancelled');
    await expect(
      client.retryRollout({
        agentId: 'agent-inbox',
        expectedJobRevision: started.revision,
        // Stale CAS uses a still-valid retry status enum member (not the live job status).
        expectedStatus: 'cancelled',
        jobId: started.jobId,
        reason: 'stale retry',
      }),
    ).rejects.toThrow('PLATFORM_AGENT_ROLLOUT_CONFLICT');
    const retried = await client.retryRollout({
      agentId: 'agent-inbox',
      expectedJobRevision: cancelled.revision,
      expectedStatus: 'cancelled',
      jobId: cancelled.jobId,
      reason: 'retry rollout',
    });
    expect(retried.status).toBe('pending');
  });

  it('switches the default Inbox atomically and requires an archive replacement', async () => {
    const client = createMockAdminAgentsClient();
    const current = await client.get({ id: 'agent-inbox' });
    // The legacy seed row is still `draft`; saving it publishes it, which is the only path now.
    const nextDraft = await client.get({ id: 'agent-research' });
    const nextVersion = (await client.listVersions({ agentId: nextDraft.identity.id })).items[0]!;
    await client.save({
      agentId: nextDraft.identity.id,
      config: nextVersion.config,
      dependencySnapshot: nextVersion.dependencySnapshot,
      expectedDraftToken: nextDraft.draftToken,
      expectedRevision: nextDraft.identity.revision,
      reason: 'publish replacement',
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
