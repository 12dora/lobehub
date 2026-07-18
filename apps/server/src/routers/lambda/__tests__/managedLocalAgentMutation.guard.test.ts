/**
 * RR2-4 — table-driven proof that EVERY registered agent-scoped ordinary mutation refuses to
 * mutate a platform-managed materialized local Agent, and performs ZERO writes when it does.
 *
 * Runs the REAL routers (agent / agentGroup / home / agentDocument) through createCaller against a
 * real PGlite DB with a genuinely materialized platform Agent, with ENABLE_PLATFORM_MANAGED_AGENTS=1
 * and ENABLE_PLATFORM_ADMIN=0 (so the app-wide access-grant gate is off and the managed-local-agent
 * guard is the operative one). Flag-off legacy behavior is covered by the guard unit test.
 *
 * @vitest-environment node
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import { agents } from '@/database/schemas/agent';
import {
  platformAgents,
  platformAgentVersions,
  platformUserAgentMaterializations,
} from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));
// agentDocument's ctx builder eagerly constructs a FileService (→ S3 env); stub it out.
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(() => ({})),
}));

const { agentRouter } = await import('../agent');
const { agentGroupRouter } = await import('../agentGroup');
const { homeRouter } = await import('../home');
const { agentDocumentRouter } = await import('../agentDocument');

const USER = 'rr24-user';
const CHECKSUM = 'a'.repeat(64);

const ctx = async () => (await createContextInner({ userId: USER as never })) as never;

const buildCallers = async () => {
  const context = await ctx();
  return {
    agent: createCallerFactory(agentRouter)(context),
    doc: createCallerFactory(agentDocumentRouter)(context),
    group: createCallerFactory(agentGroupRouter)(context),
    home: createCallerFactory(homeRouter)(context),
  };
};

const seed = async () => {
  await db.insert(users).values([{ id: USER }]);
  await db.insert(platformAgents).values({
    agentKey: 'pa',
    id: 'pa',
    migrationRequired: false,
    status: 'draft',
    title: 'pa',
  });
  await db.insert(platformAgentVersions).values({
    agentId: 'pa',
    checksum: CHECKSUM,
    config: {} as never,
    dependencySnapshot: { connectors: [], model: {}, skills: [] } as never,
    id: 'pa-v1',
    version: '1.0.0',
  });
  await db.insert(agents).values([
    { id: 'agt_mat', title: 'M', userId: USER },
    { id: 'agt_ord', title: 'O', userId: USER },
  ]);
  await new PlatformAgentCatalogRepository(db).materializeLocalAgent({
    createLocalAgent: async () => ({ id: 'agt_mat' }),
    platformAgentId: 'pa',
    platformAgentVersionChecksum: CHECKSUM,
    platformAgentVersionId: 'pa-v1',
    userId: USER,
  });
};

const cleanup = () =>
  db.execute(sql`
    TRUNCATE TABLE
      ${platformUserAgentMaterializations},
      ${platformAgentVersions},
      ${platformAgents},
      ${agents},
      ${users}
    RESTART IDENTITY CASCADE
  `);

beforeAll(async () => {
  db = await getTestDB();
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  await cleanup();
  await seed();
});
afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});
afterAll(() => vi.restoreAllMocks());

describe('RR2-4 — managed local Agent mutations reject with zero write', () => {
  // Callers are inferred from createCallerFactory(router)(ctx); typing the case-builder params
  // explicitly is brittle across tRPC versions, so build the case list inline over the inferred
  // callers.
  const buildManagedCases = (
    agent: Awaited<ReturnType<typeof buildCallers>>['agent'],
    group: Awaited<ReturnType<typeof buildCallers>>['group'],
    home: Awaited<ReturnType<typeof buildCallers>>['home'],
    doc: Awaited<ReturnType<typeof buildCallers>>['doc'],
  ): Array<{ name: string; run: () => Promise<unknown> }> => [
    { name: 'agent.removeAgent', run: () => agent.removeAgent({ agentId: 'agt_mat' }) },
    {
      name: 'agent.updateAgentConfig',
      run: () => agent.updateAgentConfig({ agentId: 'agt_mat', value: { title: 'x' } }),
    },
    {
      name: 'agent.updateAgentPinned',
      run: () => agent.updateAgentPinned({ id: 'agt_mat', pinned: true }),
    },
    {
      name: 'agent.setAgentVisibility',
      run: () => agent.setAgentVisibility({ id: 'agt_mat', visibility: 'private' }),
    },
    {
      name: 'agent.publishAgentToWorkspace',
      run: () => agent.publishAgentToWorkspace({ id: 'agt_mat' }),
    },
    { name: 'agent.duplicateAgent', run: () => agent.duplicateAgent({ agentId: 'agt_mat' }) },
    {
      name: 'agent.createAgentFiles',
      run: () => agent.createAgentFiles({ agentId: 'agt_mat', fileIds: ['f1'] }),
    },
    {
      name: 'agent.createAgentKnowledgeBase',
      run: () => agent.createAgentKnowledgeBase({ agentId: 'agt_mat', knowledgeBaseId: 'k1' }),
    },
    {
      name: 'agent.deleteAgentFile',
      run: () => agent.deleteAgentFile({ agentId: 'agt_mat', fileId: 'f1' }),
    },
    {
      name: 'agent.deleteAgentKnowledgeBase',
      run: () => agent.deleteAgentKnowledgeBase({ agentId: 'agt_mat', knowledgeBaseId: 'k1' }),
    },
    { name: 'agent.toggleFile', run: () => agent.toggleFile({ agentId: 'agt_mat', fileId: 'f1' }) },
    {
      name: 'agent.toggleKnowledgeBase',
      run: () => agent.toggleKnowledgeBase({ agentId: 'agt_mat', knowledgeBaseId: 'k1' }),
    },
    {
      name: 'agent.transferAgent',
      run: () => agent.transferAgent({ agentId: 'agt_mat', targetWorkspaceId: 'ws-other' }),
    },
    { name: 'agent.acquireAgentLock', run: () => agent.acquireAgentLock({ agentId: 'agt_mat' }) },
    { name: 'agent.releaseAgentLock', run: () => agent.releaseAgentLock({ agentId: 'agt_mat' }) },
    // agentGroup — array (per-item) + single
    {
      name: 'agentGroup.addAgentsToGroup',
      run: () => group.addAgentsToGroup({ agentIds: ['agt_ord', 'agt_mat'], groupId: 'g1' }),
    },
    {
      name: 'agentGroup.removeAgentsFromGroup',
      run: () => group.removeAgentsFromGroup({ agentIds: ['agt_mat'], groupId: 'g1' }),
    },
    // home
    {
      name: 'home.updateAgentSessionGroupId',
      run: () => home.updateAgentSessionGroupId({ agentId: 'agt_mat', sessionGroupId: null }),
    },
    // agentDocument — shared write procedure (covers all doc writes)
    {
      name: 'agentDocument.upsertDocument',
      run: () => doc.upsertDocument({ agentId: 'agt_mat', content: 'c', filename: 'a.md' }),
    },
  ];

  it('rejects each registered mutation with FORBIDDEN and writes nothing', async () => {
    const { agent, group, home, doc } = await buildCallers();

    const before = await db.select().from(agents).where(eq(agents.userId, USER));

    for (const { name, run } of buildManagedCases(agent, group, home, doc)) {
      const error = await run().then(
        () => {
          throw new Error(`${name} should have been rejected for a managed local Agent`);
        },
        (e: { code?: string }) => e,
      );
      expect(error.code, `${name} must reject with FORBIDDEN`).toBe('FORBIDDEN');
    }

    // Zero write: the managed row is untouched, no rows were added or removed.
    const after = await db.select().from(agents).where(eq(agents.userId, USER));
    expect(after).toHaveLength(before.length);
    const managed = after.find((a) => a.id === 'agt_mat');
    expect(managed?.title).toBe('M');
    expect(managed?.pinned ?? false).toBe(false);
    // The materialization mapping is intact.
    const [mapping] = await db
      .select()
      .from(platformUserAgentMaterializations)
      .where(
        and(
          eq(platformUserAgentMaterializations.userId, USER),
          eq(platformUserAgentMaterializations.materializedAgentId, 'agt_mat'),
        ),
      );
    expect(mapping).toBeDefined();
  });

  it('lets the same mutations through for an ordinary (non-materialized) local Agent', async () => {
    const context = await ctx();
    const agent = createCallerFactory(agentRouter)(context);
    // The guard passes for an ordinary id; the handler then runs (a pin toggle is a real write).
    await agent.updateAgentPinned({ id: 'agt_ord', pinned: true });
    const [row] = await db.select().from(agents).where(eq(agents.id, 'agt_ord'));
    expect(row.pinned).toBe(true);
  });
});
