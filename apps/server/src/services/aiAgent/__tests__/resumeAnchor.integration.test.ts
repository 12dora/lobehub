/**
 * RR4-1 / RR5-2 / RR5-5 — REAL service-chain adversarial tests for the KIND-keyed platform resume
 * anchor.
 *
 * Drives the REAL `AiAgentService.execAgent` resume path against a real PGlite DB with a real
 * published platform Agent + assignment + managed policy, a real server-parked (`waiting_for_human`)
 * operation, real message rows, and the SERVER-recorded provenance resume anchors — NO deep mocks of
 * the security logic. A PAUSED resume binds ONLY through server-owned ids under its OWN kind: a
 * `resumeApproval` / `resumeToolResult` against the exact message/tool/kind/fingerprint provenance.
 * The client-writable `message.parentId` is NEVER trusted
 * — a forged tool message whose parentId points at the real assistant fails closed, the two kinds
 * can't cross, and `waiting_for_async_tool` is not externally resumable. A bare regeneration /
 * continue (`parentMessageId` alone) is NOT a paused resume (RR5-5): it never replays the parked pin,
 * so it does not fail closed with the platform-resolution NOT_FOUND.
 *
 * @vitest-environment node
 */
import { fingerprintResumeToolCall } from '@lobechat/types';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { agentOperations, messagePlugins, messages, topics } from '@/database/schemas';
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
const toolCallIdFor = (toolId: string) => `tc-${toolId}`;
const toolDescriptor = (toolId: string) => ({
  apiName: 'run',
  arguments: JSON.stringify({ toolId }),
  identifier: 'demo',
  toolCallId: toolCallIdFor(toolId),
  type: 'default',
});

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
    approvalToolIds?: string[];
    assistantMessageId?: string;
    operationId: string;
    status?: 'waiting_for_human' | 'waiting_for_async_tool';
    toolResultToolIds?: string[];
    topicId: string;
  },
) => {
  const toolSpecs = [
    ...(opts.approvalToolIds ?? []).map((toolId) => ({ kind: 'approval' as const, toolId })),
    ...(opts.toolResultToolIds ?? []).map((toolId) => ({ kind: 'toolResult' as const, toolId })),
  ];
  const pendingResumeAnchors = await Promise.all(
    toolSpecs.map(async ({ kind, toolId }) => ({
      assistantMessageId: opts.assistantMessageId ?? '',
      fingerprint: await fingerprintResumeToolCall(toolDescriptor(toolId)),
      kind,
      messageId: toolId,
      operationId: opts.operationId,
      toolCallId: toolCallIdFor(toolId),
    })),
  );

  await db.insert(agentOperations).values({
    id: opts.operationId,
    metadata: {
      ...(opts.assistantMessageId ? { assistantMessageId: opts.assistantMessageId } : {}),
      ...(pendingResumeAnchors.length ? { pendingResumeAnchors } : {}),
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
  // Seed each recorded pending tool as a real role='tool' message + a plugin row carrying the
  // SERVER-owned intervention kind, so genuine resumes clear the pin resolution AND the kind gate.
  const seedTool = async (toolId: string, kind: 'approval' | 'toolResult') => {
    const provenance = pendingResumeAnchors.find((anchor) => anchor.messageId === toolId)!;
    const descriptor = toolDescriptor(toolId);
    await db.insert(messages).values({
      id: toolId,
      parentId: opts.assistantMessageId,
      role: 'tool',
      topicId: opts.topicId,
      userId,
    });
    await db.insert(messagePlugins).values({
      apiName: descriptor.apiName,
      arguments: descriptor.arguments,
      id: toolId,
      identifier: descriptor.identifier,
      intervention: { kind, provenance, status: 'pending' },
      toolCallId: descriptor.toolCallId,
      type: descriptor.type,
      userId,
    });
  };
  for (const toolId of opts.approvalToolIds ?? []) await seedTool(toolId, 'approval');
  for (const toolId of opts.toolResultToolIds ?? []) await seedTool(toolId, 'toolResult');
};

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE ${agentOperations}, ${messagePlugins}, ${messages}, ${platformUserAgentMaterializations}, ${platformAgentAssignments}, ${platformAgentVersions}, ${platformAgents}, ${platformManagedResourcePolicies}, ${topics}, ${agents}, ${users} RESTART IDENTITY CASCADE
  `);

// Run a resume through the REAL service and report whether it failed with the platform resolution
// NOT_FOUND (the stable fail-closed outcome). `approvalToolId` drives a `resumeApproval` (approval
// kind); `toolResultToolId` drives a `resumeToolResult` (toolResult kind); a bare `parentMessageId`
// drives a generic regeneration / continue (RR5-5 — a NEW operation, not a paused resume).
const resume = async (
  userId: string,
  params: {
    approvalToolId?: string;
    parentMessageId?: string;
    threadId?: string | null;
    toolResultToolId?: string;
    topicId: string;
  },
) => {
  const resumeInput = params.approvalToolId
    ? {
        resumeApproval: {
          decision: 'approved' as const,
          parentMessageId: params.approvalToolId,
          toolCallId: toolCallIdFor(params.approvalToolId),
        },
      }
    : params.toolResultToolId
      ? {
          resumeToolResult: {
            content: 'the human answer',
            parentMessageId: params.toolResultToolId,
            toolCallId: toolCallIdFor(params.toolResultToolId),
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
  // approval anchor `tool-1`, one recorded toolResult anchor `ans-1`.
  await seedParkedOperation('user-a', {
    approvalToolIds: ['tool-1'],
    assistantMessageId: 'asst-1',
    operationId: 'op-1',
    toolResultToolIds: ['ans-1'],
    topicId: 'topic-1',
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

describe('RR4-1/RR5-2 — kind-keyed resume anchor forgery resistance (real service chain)', () => {
  it('KEY: a forged tool message whose parentId points at the real assistant fails closed', async () => {
    // The exact exploit: create a tool message the attacker owns, with parentId spoofed to the real
    // op's assistant turn. Its id is NOT among the server-recorded approval anchors → no bind.
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

  it('RR5-2 kind crossing fails closed: an approval anchor via resumeToolResult (and vice versa)', async () => {
    // `tool-1` is an approval anchor — replaying it via resumeToolResult must not resolve.
    expect(
      (await resume('user-a', { toolResultToolId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
    // `ans-1` is a toolResult anchor — replaying it via resumeApproval must not resolve.
    expect(
      (await resume('user-a', { approvalToolId: 'ans-1', topicId: 'topic-1' }))
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

  it('fails closed when the persisted tool arguments no longer match the parked fingerprint', async () => {
    await db
      .update(messagePlugins)
      .set({ arguments: '{"toolId":"tampered"}' })
      .where(eq(messagePlugins.id, 'tool-1'));
    expect(
      (await resume('user-a', { approvalToolId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed when the parked provenance assistant or operation binding is tampered', async () => {
    const [operation] = await db
      .select({ metadata: agentOperations.metadata })
      .from(agentOperations)
      .where(eq(agentOperations.id, 'op-1'));
    const metadata = operation.metadata as Record<string, any>;
    const anchors = metadata.pendingResumeAnchors as Array<Record<string, unknown>>;
    await db
      .update(agentOperations)
      .set({
        metadata: {
          ...metadata,
          pendingResumeAnchors: anchors.map((anchor) =>
            anchor.messageId === 'tool-1'
              ? { ...anchor, assistantMessageId: 'forged-assistant' }
              : anchor,
          ),
        },
      })
      .where(eq(agentOperations.id, 'op-1'));
    expect(
      (await resume('user-a', { approvalToolId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('RR4-2: a waiting_for_async_tool op is NOT externally resumable', async () => {
    await seedParkedOperation('user-a', {
      approvalToolIds: ['tool-async'],
      assistantMessageId: 'asst-async',
      operationId: 'op-async',
      status: 'waiting_for_async_tool',
      topicId: 'topic-1',
    });
    expect(
      (await resume('user-a', { approvalToolId: 'tool-async', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed after revocation, even for the genuine approval anchor', async () => {
    await db
      .delete(platformAgentAssignments)
      .where(eq(platformAgentAssignments.agentId, PLATFORM_AGENT_ID));
    expect(
      (await resume('user-a', { approvalToolId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('fails closed on the wrong topic and cross-owner', async () => {
    expect(
      (await resume('user-a', { approvalToolId: 'tool-1', topicId: 'topic-2' }))
        .resolutionFailedClosed,
    ).toBe(true);
    // user-b can't even resolve user-a's owner-scoped anchor message.
    expect(
      (await resume('user-b', { approvalToolId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(true);
  });

  it('passes resolution for the GENUINE approval anchor (exact server-recorded pending tool id)', async () => {
    // `tool-1` is among the op's server-recorded approval anchors → resolution succeeds; the approval
    // machinery may fail later but that is NOT the platform resolution NOT_FOUND.
    expect(
      (await resume('user-a', { approvalToolId: 'tool-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(false);
  });

  it('passes resolution for the GENUINE toolResult anchor (exact server-recorded pending id)', async () => {
    expect(
      (await resume('user-a', { toolResultToolId: 'ans-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(false);
  });
});

describe('RR5-5 — a bare regeneration / continue is NOT a paused resume', () => {
  it('does not fail closed with the platform NOT_FOUND for a generic parentMessageId', async () => {
    // Regenerate passes the user/assistant message id, not an approval/tool-result body. It must NOT
    // replay the parked pin — it starts a FRESH operation on current entitlement — so it never hits
    // the paused-pin resolution NOT_FOUND (the pre-RR5-5 regression). Any later failure is unrelated.
    expect(
      (await resume('user-a', { parentMessageId: 'asst-1', topicId: 'topic-1' }))
        .resolutionFailedClosed,
    ).toBe(false);
  });

  it('a generic resume does not resolve the parked pin even for a forged assistant anchor', async () => {
    // Because a generic resume never touches the paused pin, a forged `metadata.operationId` on an
    // assistant message is irrelevant — the run begins a new operation regardless.
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
    ).toBe(false);
  });
});
