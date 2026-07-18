/**
 * RR4-1 — REAL service-chain adversarial tests for the KIND-keyed platform resume anchor.
 *
 * Drives the REAL `AiAgentService.execAgent` resume path against a real PGlite DB with a real
 * published platform Agent + assignment + managed policy, a real server-parked (`waiting_for_human`)
 * operation, real message rows, and the SERVER-recorded resume anchors — NO deep mocks of the
 * security logic. A resume binds ONLY through server-owned ids keyed by kind: a DIRECT (regen) anchor
 * against `metadata.assistantMessageId`, an APPROVAL/tool-result anchor against the pending tool ids
 * the runtime recorded in `metadata.pendingResumeAnchorIds`. The client-writable `message.parentId`
 * is NEVER trusted — so a forged tool message whose parentId points at the real assistant fails
 * closed, kinds can't cross, and `waiting_for_async_tool` is not externally resumable.
 *
 * @vitest-environment node
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { agentOperations, messages, topics } from '@/database/schemas';
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

let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));
vi.mock('@/server/services/file', () => ({ FileService: vi.fn().mockImplementation(() => ({})) }));
vi.mock('@/server/services/aiChat', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, AiChatService: class {} };
});

const { AiAgentService } = await import('../index');

const CHECKSUM = 'a'.repeat(64);
const PLATFORM_AGENT_ID = 'pa';
const ENCODED = `platform-agent:${PLATFORM_AGENT_ID}`;
const modelPin = {
  modelKey: 'chat-model',
  providerChecksum: 'b'.repeat(64),
  providerKey: 'internal-provider',
  providerRevision: 1,
};

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

const seedPolicy = () =>
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

const seedAgent = async () => {
  await db.insert(platformAgents).values({
    agentKey: PLATFORM_AGENT_ID,
    id: PLATFORM_AGENT_ID,
    migrationRequired: false,
    status: 'draft',
    title: PLATFORM_AGENT_ID,
  });
  await db.insert(platformAgentVersions).values({
    agentId: PLATFORM_AGENT_ID,
    checksum: CHECKSUM,
    config: config('pa v1'),
    dependencySnapshot: { connectors: [], model: modelPin, skills: [] },
    id: 'pa-v1',
    version: '1.0.0',
  });
  await db
    .update(platformAgents)
    .set({ currentVersionId: 'pa-v1', publishedAt: new Date(), revision: 1, status: 'published' })
    .where(eq(platformAgents.id, PLATFORM_AGENT_ID));
  await db.insert(platformAgentAssignments).values({
    agentId: PLATFORM_AGENT_ID,
    enabled: true,
    id: 'pa-global',
    mode: 'optional',
    status: 'active',
    targetId: '__global__',
    targetType: 'global',
    versionPolicy: 'latest_published',
  });
};

/**
 * A real server-parked (`waiting_for_human`) platform operation with the SERVER-owned resume anchors
 * recorded on it (assistant id + pending tool ids), plus the real assistant/tool message rows.
 */
const seedParkedOperation = async (
  userId: string,
  opts: {
    assistantMessageId?: string;
    operationId: string;
    pendingToolIds?: string[];
    status?: 'waiting_for_human' | 'waiting_for_async_tool';
    topicId: string;
  },
) => {
  await db.insert(agentOperations).values({
    id: opts.operationId,
    metadata: {
      ...(opts.assistantMessageId ? { assistantMessageId: opts.assistantMessageId } : {}),
      ...(opts.pendingToolIds ? { pendingResumeAnchorIds: opts.pendingToolIds } : {}),
      platformConnectors: [],
      platformModel: modelPin,
      platformOperation: {
        checksum: CHECKSUM,
        platformAgentId: PLATFORM_AGENT_ID,
        versionId: 'pa-v1',
      },
      platformSkills: [],
    },
    startedAt: new Date(),
    status: opts.status ?? 'waiting_for_human',
    topicId: opts.topicId,
    userId,
  });
  if (opts.assistantMessageId) {
    await db
      .insert(messages)
      .values({ id: opts.assistantMessageId, role: 'assistant', topicId: opts.topicId, userId });
  }
  for (const toolId of opts.pendingToolIds ?? []) {
    await db.insert(messages).values({
      id: toolId,
      parentId: opts.assistantMessageId,
      role: 'tool',
      topicId: opts.topicId,
      userId,
    });
  }
};

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE ${agentOperations}, ${messages}, ${platformUserAgentMaterializations}, ${platformAgentAssignments}, ${platformAgentVersions}, ${platformAgents}, ${platformManagedResourcePolicies}, ${topics}, ${agents}, ${users} RESTART IDENTITY CASCADE
  `);

// Run a resume through the REAL service and report whether it failed with the platform resolution
// NOT_FOUND (the stable fail-closed outcome). `approvalToolId` drives the tool kind (resumeApproval);
// `parentMessageId` drives the direct/regen kind.
const resume = async (
  userId: string,
  params: {
    approvalToolId?: string;
    parentMessageId?: string;
    threadId?: string | null;
    topicId: string;
  },
) => {
  const resumeInput = params.approvalToolId
    ? {
        resumeApproval: {
          decision: 'approved' as const,
          parentMessageId: params.approvalToolId,
          toolCallId: 'tc-1',
        },
      }
    : { parentMessageId: params.parentMessageId };
  const error = await new AiAgentService(db, userId)
    .execAgent({
      agentId: ENCODED,
      appContext: { threadId: params.threadId ?? undefined, topicId: params.topicId },
      autoStart: false,
      prompt: 'continue',
      resume: true,
      ...resumeInput,
    } as never)
    .then(
      () => null,
      (e) => e as { code?: string; message?: string },
    );
  return {
    resolutionFailedClosed:
      error?.code === 'NOT_FOUND' && String(error?.message ?? '').includes(ENCODED),
  };
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  db = await getTestDB();
  await cleanup();
  await db.insert(users).values([{ id: 'user-a' }, { id: 'user-b' }]);
  await db.insert(topics).values([
    { id: 'topic-1', userId: 'user-a' },
    { id: 'topic-2', userId: 'user-a' },
    { id: 'topic-b', userId: 'user-b' },
  ]);
  await seedPolicy();
  await seedAgent();
  // The genuine, server-parked turn for user-a on topic-1: assistant anchor `asst-1`, one recorded
  // pending tool anchor `tool-1`.
  await seedParkedOperation('user-a', {
    assistantMessageId: 'asst-1',
    operationId: 'op-1',
    pendingToolIds: ['tool-1'],
    topicId: 'topic-1',
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('RR4-1 — kind-keyed resume anchor forgery resistance (real service chain)', () => {
  it('KEY: a forged tool message whose parentId points at the real assistant fails closed', async () => {
    // The exact exploit: create a tool message the attacker owns, with parentId spoofed to the real
    // op's assistant turn. Its id is NOT among the server-recorded pending tool ids → no bind.
    await db.insert(messages).values({
      id: 'evil-tool',
      parentId: 'asst-1',
      role: 'tool',
      topicId: 'topic-1',
      userId: 'user-a',
    });
    expect(
      (await resume('user-a', { approvalToolId: 'evil-tool', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('kind crossing fails closed: assistant id as a tool anchor, tool id as a direct anchor', async () => {
    // assistant id used with the tool (approval) kind → not among pendingResumeAnchorIds.
    expect(
      (await resume('user-a', { approvalToolId: 'asst-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
    // real tool id used with the direct (assistant) kind → not the assistantMessageId.
    expect(
      (await resume('user-a', { parentMessageId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed for a forged DIRECT anchor (client metadata.operationId cannot help)', async () => {
    await db.insert(messages).values({
      id: 'forged-asst',
      metadata: { operationId: 'op-1' },
      role: 'assistant',
      topicId: 'topic-1',
      userId: 'user-a',
    });
    expect(
      (await resume('user-a', { parentMessageId: 'forged-asst', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed for a forged tool anchor not among the server-recorded pending ids', async () => {
    await db
      .insert(messages)
      .values({ id: 'ghost-tool', role: 'tool', topicId: 'topic-1', userId: 'user-a' });
    expect(
      (await resume('user-a', { approvalToolId: 'ghost-tool', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('RR4-2: a waiting_for_async_tool op is NOT externally resumable', async () => {
    await seedParkedOperation('user-a', {
      assistantMessageId: 'asst-async',
      operationId: 'op-async',
      status: 'waiting_for_async_tool',
      topicId: 'topic-1',
    });
    expect(
      (await resume('user-a', { parentMessageId: 'asst-async', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed after revocation, even for the genuine assistant anchor', async () => {
    await db
      .delete(platformAgentAssignments)
      .where(eq(platformAgentAssignments.agentId, PLATFORM_AGENT_ID));
    expect(
      (await resume('user-a', { parentMessageId: 'asst-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed on the wrong topic and cross-owner', async () => {
    expect(
      (await resume('user-a', { parentMessageId: 'asst-1', topicId: 'topic-2' }))
        .resolutionFailedClosed,
    ).toBe(true);
    // user-b can't even resolve user-a's owner-scoped anchor message.
    expect(
      (await resume('user-b', { parentMessageId: 'asst-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed when the operation carries no server assistant stamp', async () => {
    await seedParkedOperation('user-a', { operationId: 'op-nostamp', topicId: 'topic-1' });
    await db
      .insert(messages)
      .values({ id: 'asst-unbound', role: 'assistant', topicId: 'topic-1', userId: 'user-a' });
    expect(
      (await resume('user-a', { parentMessageId: 'asst-unbound', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('passes resolution for the GENUINE direct anchor (exact server assistant id), entitled', async () => {
    // The real assistant id on the correct topic, entitled → resolution succeeds (any later failure
    // is NOT the platform resolution NOT_FOUND).
    expect(
      (await resume('user-a', { parentMessageId: 'asst-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(false);
  });

  it('passes resolution for the GENUINE tool anchor (exact server-recorded pending tool id)', async () => {
    // `tool-1` is among the op's server-recorded pending tool ids → resolution succeeds; the approval
    // machinery may fail later (no plugin row seeded) but that is NOT the resolution NOT_FOUND.
    expect(
      (await resume('user-a', { approvalToolId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(false);
  });
});
