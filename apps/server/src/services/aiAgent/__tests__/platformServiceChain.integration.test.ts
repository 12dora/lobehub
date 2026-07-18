/**
 * RR2-6 — real service-chain integration for the platform Agent chat identity.
 *
 * Exercises the REAL resolver → materialization → repository → operation-persistence chain against a
 * real PGlite DB (real assignment, real managed-resource policy, real version rows), asserting on the
 * actual DB rows and persisted operation metadata pins — NOT spied helpers. The only things NOT
 * exercised here are the deep LLM/gateway runtime (a separate boundary) and execAgent's own message
 * plumbing; those are covered by the router integration tests.
 *
 * Covers: entitlement via a real assignment + policy, encoded-identity decode, materialize → real
 * local Agent row + owner-scoped mapping, second-use reuse (no second row), operation metadata exact
 * pins + the resume read-back path, revocation fail-closed, v1→v2 exactness, local-row tamper
 * (runtime config comes from the pinned version, never the row), and owner A/B isolation.
 *
 * @vitest-environment node
 */
import { decodePlatformAgentListId, encodePlatformAgentListId } from '@lobechat/types';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { AgentOperationModel } from '@/database/models/agentOperation';
import { agentOperations, topics } from '@/database/schemas';
import { agents } from '@/database/schemas/agent';
import {
  platformAgentAssignments,
  platformAgents,
  platformAgentVersions,
  platformManagedResourcePolicies,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';
import {
  PlatformAgentEffectiveResolver,
  PlatformAgentMaterializationService,
} from '@/server/enterprise/services/agentCatalog';

const db: LobeChatDatabase = await getTestDB();

const CHECKSUM_V1 = 'a'.repeat(64);
const CHECKSUM_V2 = 'c'.repeat(64);
const modelPin = {
  modelKey: 'chat-model',
  providerChecksum: 'b'.repeat(64),
  providerKey: 'internal-provider',
  providerRevision: 1,
};
const approvalAnchor = {
  assistantMessageId: 'asst-1',
  fingerprint: 'd'.repeat(64),
  kind: 'approval' as const,
  messageId: 'tool-1',
  operationId: 'op-1',
  toolCallId: 'call-tool-1',
};
const toolResultAnchor = {
  assistantMessageId: 'asst-1',
  fingerprint: 'e'.repeat(64),
  kind: 'toolResult' as const,
  messageId: 'ans-1',
  operationId: 'op-1',
  toolCallId: 'call-ans-1',
};
const dependencySnapshot = { connectors: [], model: modelPin, skills: [] };

const config = (title: string) => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName: title,
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: `${title} role`,
  tags: [],
});

const POLICY_RESOURCES = ['agents', 'aiModels', 'aiProviders', 'connectors', 'skills'] as const;

/** Publish the managed-resource policy with Agents enforced (what the real resolver reads). */
const seedEnforcedPolicy = () =>
  db.insert(platformManagedResourcePolicies).values(
    POLICY_RESOURCES.map((resource) => {
      const published =
        resource === 'agents'
          ? { enforcementMode: 'enforced' as const, managed: true }
          : { enforcementMode: 'observe' as const, managed: false };
      return {
        config: { draft: published, published },
        enforcement: published.enforcementMode,
        resource,
        revision: 1,
        status: 'published' as const,
      };
    }),
  );

const seedPublishedAgent = async (id: string) => {
  await db.insert(platformAgents).values({
    agentKey: id,
    id,
    migrationRequired: false,
    status: 'draft',
    title: id,
  });
  await db.insert(platformAgentVersions).values({
    agentId: id,
    checksum: CHECKSUM_V1,
    config: config(`${id} v1`),
    dependencySnapshot,
    id: `${id}-v1`,
    version: '1.0.0',
  });
  await db
    .update(platformAgents)
    .set({
      currentVersionId: `${id}-v1`,
      publishedAt: new Date(),
      revision: 1,
      status: 'published',
    })
    .where(eq(platformAgents.id, id));
  await db.insert(platformAgentAssignments).values({
    agentId: id,
    enabled: true,
    id: `${id}-global`,
    mode: 'optional',
    status: 'active',
    targetId: '__global__',
    targetType: 'global',
    versionPolicy: 'latest_published',
  });
};

const publishV2 = async (id: string) => {
  await db.insert(platformAgentVersions).values({
    agentId: id,
    checksum: CHECKSUM_V2,
    config: config(`${id} v2`),
    dependencySnapshot,
    id: `${id}-v2`,
    version: '2.0.0',
  });
  await db
    .update(platformAgents)
    .set({ currentVersionId: `${id}-v2`, revision: 2 })
    .where(eq(platformAgents.id, id));
};

const resolver = () => new PlatformAgentEffectiveResolver(db);
const materialization = (userId: string) => new PlatformAgentMaterializationService(db, userId);

const mappingFor = (userId: string, platformAgentId: string) =>
  db
    .select()
    .from(platformUserAgentMaterializations)
    .where(
      and(
        eq(platformUserAgentMaterializations.userId, userId),
        eq(platformUserAgentMaterializations.platformAgentId, platformAgentId),
      ),
    );

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE
      ${agentOperations},
      ${platformUserAgentMaterializations},
      ${platformAgentAssignments},
      ${platformAgentVersions},
      ${platformAgents},
      ${platformManagedResourcePolicies},
      ${topics},
      ${agents},
      ${users}
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  await cleanup();
  await db.insert(users).values([{ id: 'user-a' }, { id: 'user-b' }]);
  await seedEnforcedPolicy();
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('RR2-6 — real platform Agent service chain', () => {
  it('assignment → encoded exec → beginOperation → materialize → real DB rows + exact operation pin', async () => {
    await seedPublishedAgent('pa');

    // The client-supplied identity is the encoded list item; decode is a pure hint, entitlement is
    // re-resolved by the REAL resolver against the real assignment + policy.
    const platformAgentId = decodePlatformAgentListId(encodePlatformAgentListId('pa'));
    expect(platformAgentId).toBe('pa');

    const handle = await resolver().beginOperation('user-a', platformAgentId!);
    expect(handle).not.toBeNull();
    const snapshot = handle!.getSnapshot();
    expect(snapshot).toMatchObject({
      checksum: CHECKSUM_V1,
      platformAgentId: 'pa',
      versionId: 'pa-v1',
    });

    const materialized = await materialization('user-a').materializeForOperation(snapshot);

    // Real local Agent row (attribution identity), owner-scoped.
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, materialized.agentId));
    expect(agentRow.userId).toBe('user-a');
    expect(agentRow.title).toBe('pa v1');
    // Real owner-scoped mapping.
    const [mapping] = await mappingFor('user-a', 'pa');
    expect(mapping).toMatchObject({
      materializedAgentId: materialized.agentId,
      platformAgentVersionId: 'pa-v1',
    });
    // Exact secret-free pins derived from the version's dependency snapshot.
    expect(materialized.dependencySnapshot.model).toEqual(modelPin);

    // Persist the operation exactly as execAgent would (server-controlled assistant-message anchor +
    // exact pins), park it on human approval, then prove the resume + model-runtime reads.
    await db.insert(topics).values({ id: 'topic-1', userId: 'user-a' });
    const opModel = new AgentOperationModel(db, 'user-a');
    await opModel.recordStart({
      agentId: materialized.agentId,
      metadata: {
        // A COMPLETE platform-start binding (RR4-3): all four pins + the server-owned assistant anchor.
        assistantMessageId: 'asst-1',
        platformConnectors: [],
        platformModel: modelPin,
        platformOperation: {
          checksum: snapshot.checksum,
          platformAgentId: 'pa',
          versionId: snapshot.versionId,
        },
        platformSkills: [],
      },
      operationId: 'op-1',
      topicId: 'topic-1',
    });
    // The runtime parks the op ATOMICALLY (RR5-3): the waiting_for_human flip + the kind-keyed,
    // server-created pending tool ids land in one CAS.
    const parked = await opModel.parkForHumanIntervention('op-1', {
      anchors: [approvalAnchor, toolResultAnchor],
      completionReason: 'waiting_for_human',
      expectedGeneration: 0,
      expectedPlatformStart: {
        assistantMessageId: 'asst-1',
        platformConnectors: [],
        platformModel: modelPin,
        platformOperation: {
          checksum: snapshot.checksum,
          platformAgentId: 'pa',
          versionId: snapshot.versionId,
        },
        platformSkills: [],
      },
      status: 'waiting_for_human',
    });
    expect(parked.affected).toBe(1);

    // Resume read-back (RR4-1/RR5-2): each kind matches ONLY its own server-recorded pending id.
    expect(
      await opModel.findResumablePlatformOperationPin({
        anchorKind: 'approval',
        anchorMessageId: 'tool-1',
        fingerprint: approvalAnchor.fingerprint,
        platformAgentId: 'pa',
        threadId: null,
        toolCallId: approvalAnchor.toolCallId,
        topicId: 'topic-1',
      }),
    ).toEqual({ checksum: CHECKSUM_V1, platformAgentId: 'pa', versionId: 'pa-v1' });
    expect(
      await opModel.findResumablePlatformOperationPin({
        anchorKind: 'toolResult',
        anchorMessageId: 'ans-1',
        fingerprint: toolResultAnchor.fingerprint,
        platformAgentId: 'pa',
        threadId: null,
        toolCallId: toolResultAnchor.toolCallId,
        topicId: 'topic-1',
      }),
    ).toEqual({ checksum: CHECKSUM_V1, platformAgentId: 'pa', versionId: 'pa-v1' });
    // Kind crossing never binds.
    expect(
      await opModel.findResumablePlatformOperationPin({
        anchorKind: 'toolResult',
        anchorMessageId: 'tool-1',
        fingerprint: approvalAnchor.fingerprint,
        platformAgentId: 'pa',
        threadId: null,
        toolCallId: approvalAnchor.toolCallId,
        topicId: 'topic-1',
      }),
    ).toBeNull();
    // Model-runtime classification: platform op + exact model pin.
    expect(await opModel.findPlatformOperationRef('op-1')).toEqual({
      classification: 'complete',
      isPlatformOperation: true,
      modelPin,
      platformStart: {
        assistantMessageId: 'asst-1',
        platformConnectors: [],
        platformModel: modelPin,
        platformOperation: {
          checksum: snapshot.checksum,
          platformAgentId: 'pa',
          versionId: snapshot.versionId,
        },
        platformSkills: [],
      },
    });
  });

  it('reuses the same local Agent on second use and never creates a second row', async () => {
    await seedPublishedAgent('pa');
    const first = await materialization('user-a').materializeForOperation(
      (await resolver().beginOperation('user-a', 'pa'))!.getSnapshot(),
    );
    const second = await materialization('user-a').materializeForOperation(
      (await resolver().beginOperation('user-a', 'pa'))!.getSnapshot(),
    );
    expect(second.agentId).toBe(first.agentId);
    expect(await db.select().from(agents).where(eq(agents.userId, 'user-a'))).toHaveLength(1);
  });

  it('fails closed when the assignment is revoked (no entitlement, no materialization)', async () => {
    await seedPublishedAgent('pa');
    await db.delete(platformAgentAssignments).where(eq(platformAgentAssignments.agentId, 'pa'));
    expect(await resolver().beginOperation('user-a', 'pa')).toBeNull();
  });

  it('keeps an in-flight v1 on v1 after v2 is published; a new operation resolves v2', async () => {
    await seedPublishedAgent('pa');
    const snapshotV1 = (await resolver().beginOperation('user-a', 'pa'))!.getSnapshot();
    expect(snapshotV1.versionId).toBe('pa-v1');

    await publishV2('pa');
    const snapshotV2 = (await resolver().beginOperation('user-a', 'pa'))!.getSnapshot();
    expect(snapshotV2.versionId).toBe('pa-v2');

    // The v1 pin re-derives v1's exact config from the immutable version, not the advanced pointer.
    const fromV1 = await materialization('user-a').materializeFromPin({
      checksum: CHECKSUM_V1,
      platformAgentId: 'pa',
      versionId: 'pa-v1',
    });
    expect(fromV1.config.title).toBe('pa v1');
    const fromV2 = await materialization('user-a').materializeForOperation(snapshotV2);
    expect(fromV2.config.title).toBe('pa v2');
    expect(fromV2.agentId).toBe(fromV1.agentId);
  });

  it('keeps the builtin inbox unmapped across default A→B while old operations replay A', async () => {
    await seedPublishedAgent('default-a');
    await seedPublishedAgent('default-b');
    await db
      .update(platformAgents)
      .set({ isDefault: true, systemKey: 'default-inbox' })
      .where(eq(platformAgents.id, 'default-a'));
    await db.insert(agents).values({
      id: 'builtin-inbox-id',
      slug: 'inbox',
      userId: 'user-a',
      workspaceId: null,
    });

    const capturedA = await resolver().beginSystemOperation('user-a', 'default-inbox');
    expect(capturedA?.platformAgentId).toBe('default-a');
    const resolvedA = await materialization('user-a').resolveForExistingAgent(
      capturedA!.getSnapshot(),
      'builtin-inbox-id',
    );
    expect(resolvedA.config.title).toBe('default-a v1');

    await db.insert(topics).values({ id: 'topic-default', userId: 'user-a' });
    const opModel = new AgentOperationModel(db, 'user-a');
    const platformOperation = {
      checksum: capturedA!.getSnapshot().checksum,
      platformAgentId: 'default-a',
      versionId: capturedA!.getSnapshot().versionId,
    };
    await opModel.recordStart({
      agentId: 'builtin-inbox-id',
      metadata: {
        assistantMessageId: 'asst-1',
        platformConnectors: [],
        platformModel: modelPin,
        platformOperation,
        platformSkills: [],
      },
      operationId: 'op-1',
      topicId: 'topic-default',
    });
    await opModel.parkForHumanIntervention('op-1', {
      anchors: [approvalAnchor],
      completionReason: 'waiting_for_human',
      expectedGeneration: 0,
      expectedPlatformStart: {
        assistantMessageId: 'asst-1',
        platformConnectors: [],
        platformModel: modelPin,
        platformOperation,
        platformSkills: [],
      },
      status: 'waiting_for_human',
    });

    await db
      .update(platformAgents)
      .set({ isDefault: false, systemKey: null })
      .where(eq(platformAgents.id, 'default-a'));
    await db
      .update(platformAgents)
      .set({ isDefault: true, systemKey: 'default-inbox' })
      .where(eq(platformAgents.id, 'default-b'));

    const capturedB = await resolver().beginSystemOperation('user-a', 'default-inbox');
    expect(capturedB?.platformAgentId).toBe('default-b');
    const historicalPin = await opModel.findResumablePlatformOperationPin({
      anchorKind: 'approval',
      anchorMessageId: approvalAnchor.messageId,
      fingerprint: approvalAnchor.fingerprint,
      threadId: null,
      toolCallId: approvalAnchor.toolCallId,
      topicId: 'topic-default',
    });
    expect(historicalPin?.platformAgentId).toBe('default-a');
    const resumedA = await materialization('user-a').resolveFromPinForExistingAgent(
      historicalPin!,
      'builtin-inbox-id',
    );
    expect(resumedA.config.title).toBe('default-a v1');
    expect(await mappingFor('user-a', 'default-a')).toEqual([]);
    expect(await mappingFor('user-a', 'default-b')).toEqual([]);
    expect(
      await db.select({ id: agents.id, workspaceId: agents.workspaceId }).from(agents),
    ).toEqual([{ id: 'builtin-inbox-id', workspaceId: null }]);
  });

  it('runtime config comes from the pinned version even after the local Agent row is tampered', async () => {
    await seedPublishedAgent('pa');
    const materialized = await materialization('user-a').materializeForOperation(
      (await resolver().beginOperation('user-a', 'pa'))!.getSnapshot(),
    );
    // Tamper the local row's managed fields — the runtime authority is the snapshot, never the row.
    await db
      .update(agents)
      .set({ title: 'HIJACKED', model: 'evil-model' })
      .where(eq(agents.id, materialized.agentId));

    const replayed = await materialization('user-a').materializeFromPin({
      checksum: CHECKSUM_V1,
      platformAgentId: 'pa',
      versionId: 'pa-v1',
    });
    expect(replayed.config.title).toBe('pa v1');
    expect(replayed.config.model).toBe('chat-model');
  });

  it('is owner-scoped: user A and user B each materialize their own isolated local Agent', async () => {
    await seedPublishedAgent('pa');
    const a = await materialization('user-a').materializeForOperation(
      (await resolver().beginOperation('user-a', 'pa'))!.getSnapshot(),
    );
    const b = await materialization('user-b').materializeForOperation(
      (await resolver().beginOperation('user-b', 'pa'))!.getSnapshot(),
    );
    expect(b.agentId).not.toBe(a.agentId);
    expect((await db.select().from(agents).where(eq(agents.id, a.agentId)))[0].userId).toBe(
      'user-a',
    );
    expect((await db.select().from(agents).where(eq(agents.id, b.agentId)))[0].userId).toBe(
      'user-b',
    );
    expect(await mappingFor('user-a', 'pa')).toHaveLength(1);
    expect(await mappingFor('user-b', 'pa')).toHaveLength(1);
  });
});
