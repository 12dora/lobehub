/**
 * RR3-1 — REAL service-chain adversarial tests for the platform resume anchor.
 *
 * Drives the REAL `AiAgentService.execAgent` resume path against a real PGlite DB with a real
 * published platform Agent + assignment + managed policy, a real server-bound paused operation, and
 * real message rows — NO deep mocks of the security logic. The resume must bind ONLY through the
 * SERVER-controlled `agent_operations.metadata.assistantMessageId`, never client-writable message
 * metadata, so every forged / cross-owner / wrong-scope / revoked / unbound attempt fails closed
 * (the stable platform NOT_FOUND), while a genuine server-bound anchor passes resolution.
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

/** A real server-bound paused operation + its real assistant/tool messages, owned by `userId`. */
const seedPausedOperation = async (
  userId: string,
  opts: {
    assistantMessageId?: string;
    operationId: string;
    toolMessageId?: string;
    topicId: string;
  },
) => {
  await db.insert(agentOperations).values({
    id: opts.operationId,
    metadata: {
      ...(opts.assistantMessageId ? { assistantMessageId: opts.assistantMessageId } : {}),
      platformModel: modelPin,
      platformOperation: {
        checksum: CHECKSUM,
        platformAgentId: PLATFORM_AGENT_ID,
        versionId: 'pa-v1',
      },
    },
    startedAt: new Date(),
    status: 'waiting_for_human',
    topicId: opts.topicId,
    userId,
  });
  if (opts.assistantMessageId) {
    await db
      .insert(messages)
      .values({ id: opts.assistantMessageId, role: 'assistant', topicId: opts.topicId, userId });
  }
  if (opts.toolMessageId && opts.assistantMessageId) {
    await db.insert(messages).values({
      id: opts.toolMessageId,
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

// Run a resume through the REAL service and return whether it failed with the platform NOT_FOUND.
const resume = async (
  userId: string,
  params: { parentMessageId: string; threadId?: string | null; topicId: string },
) => {
  const error = await new AiAgentService(db, userId)
    .execAgent({
      agentId: ENCODED,
      appContext: { threadId: params.threadId ?? undefined, topicId: params.topicId },
      autoStart: false,
      parentMessageId: params.parentMessageId,
      prompt: 'continue',
      resume: true,
    } as never)
    .then(
      () => null,
      (e) => e as { code?: string; message?: string },
    );
  return {
    // The stable platform resolution failure is a NOT_FOUND carrying the request identifier.
    resolutionFailedClosed:
      error?.code === 'NOT_FOUND' && String(error?.message ?? '').includes(ENCODED),
    error,
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
  // The genuine, server-bound paused turn for user-a on topic-1.
  await seedPausedOperation('user-a', {
    assistantMessageId: 'asst-1',
    operationId: 'op-1',
    toolMessageId: 'tool-1',
    topicId: 'topic-1',
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('RR3-1 — resume anchor forgery resistance (real service chain)', () => {
  it('fails closed for a forged DIRECT anchor carrying a client-set metadata.operationId', async () => {
    // A real message the attacker owns, with a forged metadata.operationId — but it is NOT the
    // operation's server-bound assistant turn, and has no parent that is.
    await db.insert(messages).values({
      id: 'forged-1',
      metadata: { operationId: 'op-1' },
      role: 'assistant',
      topicId: 'topic-1',
      userId: 'user-a',
    });
    expect(
      (await resume('user-a', { parentMessageId: 'forged-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed for a forged tool→assistant chain that binds to no operation', async () => {
    // A tool message whose parent assistant is NOT any operation's bound assistant turn.
    await db
      .insert(messages)
      .values({ id: 'ghost-asst', role: 'assistant', topicId: 'topic-1', userId: 'user-a' });
    await db.insert(messages).values({
      id: 'tool-forged',
      parentId: 'ghost-asst',
      role: 'tool',
      topicId: 'topic-1',
      userId: 'user-a',
    });
    expect(
      (await resume('user-a', { parentMessageId: 'tool-forged', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed after revocation even for the genuine server-bound anchor (one-hop)', async () => {
    await db
      .delete(platformAgentAssignments)
      .where(eq(platformAgentAssignments.agentId, PLATFORM_AGENT_ID));
    expect(
      (await resume('user-a', { parentMessageId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed when the resume turn targets the wrong topic', async () => {
    expect(
      (await resume('user-a', { parentMessageId: 'tool-1', topicId: 'topic-2' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed cross-owner: user B cannot bind to user A’s operation via A’s message', async () => {
    // The anchor message is owner-scoped, so user B never even resolves user A's message.
    expect(
      (await resume('user-b', { parentMessageId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed when the operation carries no server-controlled assistant-message stamp', async () => {
    await seedPausedOperation('user-a', {
      assistantMessageId: undefined,
      operationId: 'op-nostamp',
      topicId: 'topic-1',
    });
    // A real assistant message with no operation bound to it.
    await db
      .insert(messages)
      .values({ id: 'asst-unbound', role: 'assistant', topicId: 'topic-1', userId: 'user-a' });
    expect(
      (await resume('user-a', { parentMessageId: 'asst-unbound', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('passes resolution for the GENUINE server-bound anchor (one-hop tool→assistant), entitled', async () => {
    // The real bound tool message on the correct topic, with a live assignment → resolution succeeds
    // (any later failure is NOT the platform resolution NOT_FOUND).
    expect(
      (await resume('user-a', { parentMessageId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(false);
  });
});
