/**
 * Task G2 — under a published enforced agents policy, ordinary-user list reads
 * replace (do not union) the local agent set: inbox + assigned platform agents only.
 *
 * Lives next to the catalog service so enterprise imports stay inside the
 * enterprise tree (lambda `__tests__` files are not mount points).
 *
 * @vitest-environment node
 */
import { INBOX_SESSION_ID } from '@lobechat/const';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { agents, users } from '@/database/schemas';
import { platformManagedResourcePolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { getEnterpriseErrorBody } from '@/server/enterprise/guards/enterpriseErrors';
import { agentRouter } from '@/server/routers/lambda/agent';
import { homeRouter } from '@/server/routers/lambda/home';
import { messengerRouter } from '@/server/routers/lambda/messenger';

import { resetPlatformAgentTakeoverCacheForTest } from './enforcement';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));
vi.mock('next/server', () => ({
  after: (cb: () => void | Promise<void>) => {
    void cb();
  },
}));

const USER = 'g2-replace-user';
const USER_AGENT_ID = 'agt_user_owned';

const ctx = async () => (await createContextInner({ userId: USER as never })) as never;

const publishAgentsTakeover = async () => {
  const model = new PlatformManagedResourcePolicyModel(db);
  await model.ensureRows();
  const policies = createUnmanagedResourcePolicyMap();
  policies.agents = { enforcementMode: 'enforced', managed: true };
  await model.materializePublished({ policies, revision: 1 });
  resetPlatformAgentTakeoverCacheForTest();
};

beforeAll(async () => {
  db = await getTestDB();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  resetPlatformAgentTakeoverCacheForTest();
  await db.delete(platformManagedResourcePolicies);
  await db.delete(agents);
  await db.delete(users);
  await db.insert(users).values({ id: USER });
  await db.insert(agents).values({
    id: USER_AGENT_ID,
    title: 'User owned',
    userId: USER,
    virtual: false,
  });
});

afterEach(async () => {
  await db.delete(platformManagedResourcePolicies);
  await db.delete(agents);
  await db.delete(users);
  vi.unstubAllEnvs();
  resetPlatformAgentTakeoverCacheForTest();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('user list replace under published enforced agents policy', () => {
  it('home.getSidebarAgentList returns no user-owned ids', async () => {
    await publishAgentsTakeover();
    const caller = createCallerFactory(homeRouter)(await ctx());
    const result = await caller.getSidebarAgentList();

    const ids = [
      ...result.ungrouped.map((item) => item.id),
      ...result.pinned.map((item) => item.id),
      ...result.privateUngrouped.map((item) => item.id),
      ...result.groups.flatMap((group) => group.items.map((item) => item.id)),
      ...result.privateGroups.flatMap((group) => group.items.map((item) => item.id)),
    ];
    expect(ids).not.toContain(USER_AGENT_ID);
    expect(result.groups).toEqual([]);
    expect(result.pinned).toEqual([]);
    expect(result.privateGroups).toEqual([]);
    expect(result.privateUngrouped).toEqual([]);
    expect(result.ungrouped.length).toBeGreaterThanOrEqual(1);
  });

  it('agent.queryAgents returns no user-owned ids', async () => {
    await publishAgentsTakeover();
    const caller = createCallerFactory(agentRouter)(await ctx());
    const result = await caller.queryAgents({ limit: 50, offset: 0 });

    expect(result.map((item) => item.id)).not.toContain(USER_AGENT_ID);
  });

  it('messenger.listAgentsForBinding returns no user-owned ids', async () => {
    await publishAgentsTakeover();
    const caller = createCallerFactory(messengerRouter)(await ctx());
    const result = await caller.listAgentsForBinding();

    expect(result.map((item) => item.id)).not.toContain(USER_AGENT_ID);
    expect(result.some((item) => item.isInbox)).toBe(true);
  });

  it('agent.getAgentConfigById denies a user-owned local agent', async () => {
    await publishAgentsTakeover();
    const caller = createCallerFactory(agentRouter)(await ctx());

    const error = await caller.getAgentConfigById({ agentId: USER_AGENT_ID }).then(
      () => {
        throw new Error('expected getAgentConfigById to deny the user-owned agent');
      },
      (e) => e,
    );

    expect((error as { code?: string }).code).toBe('FORBIDDEN');
    expect(getEnterpriseErrorBody(error)?.code).toBe(
      MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
    );
  });

  it('agent.getAgentConfigById still serves the builtin inbox', async () => {
    await publishAgentsTakeover();
    const caller = createCallerFactory(agentRouter)(await ctx());
    const inbox = await caller.getBuiltinAgent({ slug: INBOX_SESSION_ID });
    const inboxId = inbox?.id;
    expect(inboxId).toBeTruthy();
    if (!inboxId) throw new Error('expected builtin inbox id');

    const config = await caller.getAgentConfigById({ agentId: inboxId });
    expect(config?.id).toBe(inboxId);
    const [row] = await db
      .select({ slug: agents.slug })
      .from(agents)
      .where(eq(agents.id, inboxId))
      .limit(1);
    expect(row?.slug).toBe(INBOX_SESSION_ID);
  });
});
