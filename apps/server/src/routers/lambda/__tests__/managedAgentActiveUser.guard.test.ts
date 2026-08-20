/**
 * REWORK-3 regression — the ordinary-user entrypoints that gained a managed-Agent surface under
 * M10 (agent.queryAgents, home.getSidebarAgentList / searchAgents, aiAgent.execAgent) must reject
 * banned / inactive / epoch-invalid principals when the managed-agents flag is on (ADMIN=0 +
 * MANAGED_AGENTS=1), BEFORE any platform projection / entitlement / materialization runs.
 *
 * Flag OFF must preserve the legacy behavior with zero platform access — the guard is a no-op and
 * the ordinary handler still runs, so we do not silently broaden the legacy restriction.
 *
 * @vitest-environment node
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { trpc } from '@/libs/trpc/lambda/init';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { withActiveUserWhenManagedAgents } from '@/server/enterprise/guards/activeUser';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));

// Spy the enterprise list adapter so we can prove the guard rejects BEFORE any platform catalog
// access. The guard's active-user determination still runs against real banned / epoch DB rows.
const {
  getEffectiveAgentSpy,
  mergeAvailableAgents,
  mergeSidebarList,
  mergeSearchResults,
  listCtor,
} = vi.hoisted(() => ({
  getEffectiveAgentSpy: vi.fn(async () => null),
  listCtor: vi.fn(),
  mergeAvailableAgents: vi.fn(
    async (
      _userId?: string,
      _params?: unknown,
      _loadManaged?: unknown,
      _loadLegacy?: () => Promise<unknown[]>,
    ) => [] as unknown[],
  ),
  mergeSearchResults: vi.fn(async () => [] as unknown[]),
  mergeSidebarList: vi.fn(async (_userId: string, base: unknown) => base),
}));

vi.mock('@/server/enterprise/services/agentCatalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    PlatformAgentEffectiveResolver: class {
      getEffectiveAgent = getEffectiveAgentSpy;
    },
    PlatformAgentUserListService: class {
      mergeAvailableAgents = mergeAvailableAgents;
      mergeSearchResults = mergeSearchResults;
      mergeSidebarList = mergeSidebarList;
      constructor(...ctorArgs: unknown[]) {
        listCtor(...ctorArgs);
      }
    },
  };
});

// Spy the runtime so the platform chat guard can be proven to reject before execAgent runs.
const execAgentSpy = vi.hoisted(() => vi.fn(async () => ({ operationId: 'op-stub' })));
vi.mock('@/server/services/aiAgent', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    AiAgentService: class {
      execAgent = execAgentSpy;
    },
  };
});

// The aiAgent procedure's ctx builder constructs AiChatService (→ S3) eagerly; stub it so the
// harness does not require S3 env. Irrelevant to the guard under test.
vi.mock('@/server/services/aiChat', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, AiChatService: class {} };
});

// Imported AFTER the mocks are registered.
const { agentRouter } = await import('../agent');
const { homeRouter } = await import('../home');
const { aiAgentRouter } = await import('../aiAgent');

const IDS = { active: 'rw3-active', banned: 'rw3-banned', epoch: 'rw3-epoch' } as const;

const ctx = async (
  userId: string | null,
  extras?: { authMethod?: 'better-auth' | 'oidc'; credentialIssuedAt?: Date | null },
) =>
  (await createContextInner({
    authMethod: extras?.authMethod ?? 'oidc',
    credentialIssuedAt:
      extras && 'credentialIssuedAt' in extras
        ? extras.credentialIssuedAt
        : new Date('2020-01-01T00:00:00.000Z'),
    userId: userId as never,
  })) as never;

const cleanup = () => db.delete(users);

// Require the specific active-user rejection (UNAUTHORIZED), so an incidental construction error
// cannot masquerade as a guard rejection.
const rejects = async (run: () => Promise<unknown>) => {
  const error = await run().then(
    () => {
      throw new Error('expected the managed-agent guard to reject');
    },
    (e) => e,
  );
  expect((error as { code?: string }).code).toBe('UNAUTHORIZED');
};

beforeAll(async () => {
  db = await getTestDB();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await cleanup();
  await db
    .insert(users)
    .values([
      { id: IDS.active },
      { banned: true, id: IDS.banned },
      { authInvalidatedAt: new Date('2021-01-01T00:00:00.000Z'), id: IDS.epoch },
    ]);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  vi.restoreAllMocks();
});

describe('REWORK-3 — managed flag ON (ADMIN=0, MANAGED_AGENTS=1) rejects before platform access', () => {
  beforeEach(() => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
  });

  it('agent.queryAgents rejects a banned caller before the list adapter runs', async () => {
    const caller = createCallerFactory(agentRouter)(await ctx(IDS.banned));
    await rejects(() => caller.queryAgents({ limit: 10 }));
    expect(mergeAvailableAgents).not.toHaveBeenCalled();
    expect(listCtor).not.toHaveBeenCalled();
  });

  it('agent.queryAgents rejects an epoch-invalid caller', async () => {
    const caller = createCallerFactory(agentRouter)(await ctx(IDS.epoch, { authMethod: 'oidc' }));
    await rejects(() => caller.queryAgents({ limit: 10 }));
    expect(mergeAvailableAgents).not.toHaveBeenCalled();
  });

  it('agent.queryAgents lets an active caller through to the adapter', async () => {
    const caller = createCallerFactory(agentRouter)(await ctx(IDS.active));
    await caller.queryAgents({ limit: 10 });
    expect(mergeAvailableAgents).toHaveBeenCalledTimes(1);
  });

  it('agent.getAgentConfigById rejects a banned caller before getEffectiveAgent', async () => {
    const caller = createCallerFactory(agentRouter)(await ctx(IDS.banned));
    await rejects(() => caller.getAgentConfigById({ agentId: 'platform-agent:pagt_1' }));
    expect(getEffectiveAgentSpy).not.toHaveBeenCalled();
  });

  it('home.getSidebarAgentList rejects a banned caller before the sidebar merge', async () => {
    const caller = createCallerFactory(homeRouter)(await ctx(IDS.banned));
    await rejects(() => caller.getSidebarAgentList());
    expect(mergeSidebarList).not.toHaveBeenCalled();
  });

  it('home.searchAgents rejects a banned caller before the search merge', async () => {
    const caller = createCallerFactory(homeRouter)(await ctx(IDS.banned));
    await rejects(() => caller.searchAgents({ keyword: 'x' }));
    expect(mergeSearchResults).not.toHaveBeenCalled();
  });

  it('aiAgent.execAgent rejects a banned caller before the runtime starts', async () => {
    const caller = createCallerFactory(aiAgentRouter)(await ctx(IDS.banned));
    await rejects(() => caller.execAgent({ agentId: 'platform-agent:pagt_1', prompt: 'hi' }));
    expect(execAgentSpy).not.toHaveBeenCalled();
  });

  // RR2-3: the batch entrypoint reaches the same runtime and must reject before any per-task work.
  it('aiAgent.execAgents (batch) rejects a banned caller before any task runs', async () => {
    const caller = createCallerFactory(aiAgentRouter)(await ctx(IDS.banned));
    await rejects(() =>
      caller.execAgents({ tasks: [{ agentId: 'platform-agent:pagt_1', prompt: 'hi' }] }),
    );
    expect(execAgentSpy).not.toHaveBeenCalled();
  });

  it('aiAgent.execAgents (batch) lets an active caller through to the runtime', async () => {
    const caller = createCallerFactory(aiAgentRouter)(await ctx(IDS.active));
    await caller.execAgents({ tasks: [{ agentId: 'agt_local', autoStart: false, prompt: 'hi' }] });
    expect(execAgentSpy).toHaveBeenCalledTimes(1);
  });
});

// RR2-7: the extra ban/epoch restriction exists ONLY because of the managed surface. Prove the
// `withActiveUserWhenManagedAgents` guard in ISOLATION (a minimal procedure carrying only
// serverDatabase + the guard), so the assertion is about the guard's own flag behavior and not the
// separate ADMIN access-grant gate that fires app-wide when ENABLE_PLATFORM_ADMIN=1.
describe('RR2-7 — withActiveUserWhenManagedAgents gates strictly on ENABLE_PLATFORM_MANAGED_AGENTS', () => {
  const guardRouter = trpc.router({
    ping: trpc.procedure
      .use(serverDatabase)
      .use(withActiveUserWhenManagedAgents())
      .query(() => 'ok' as const),
  });
  const ping = async (userId: string): Promise<{ error?: { code?: string }; value?: 'ok' }> =>
    createCallerFactory(guardRouter)(await ctx(userId))
      .ping()
      .then(
        (value) => ({ value }),
        (error: { code?: string }) => ({ error }),
      );

  it('MANAGED=1 → rejects a banned caller (the guard fires)', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    expect((await ping(IDS.banned)).error?.code).toBe('UNAUTHORIZED');
    expect((await ping(IDS.active)).value).toBe('ok');
  });

  it('MANAGED=0 + ADMIN=1 → legacy pass-through for banned / inactive (ADMIN alone adds no restriction)', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    expect((await ping(IDS.active)).value).toBe('ok');
    expect((await ping(IDS.banned)).value).toBe('ok');
    expect((await ping(IDS.epoch)).value).toBe('ok');
  });

  it('MANAGED=0 + ADMIN=0 → legacy pass-through', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
    expect((await ping(IDS.banned)).value).toBe('ok');
  });
});

describe('REWORK-3 — flag OFF preserves legacy behavior (no new restriction)', () => {
  beforeEach(() => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '0');
  });

  it('agent.queryAgents still serves a banned caller (guard is a no-op)', async () => {
    mergeAvailableAgents.mockImplementationOnce(async (...args: unknown[]) => {
      const loadLegacy = args[3] as () => Promise<unknown[]>;
      return loadLegacy();
    });
    const caller = createCallerFactory(agentRouter)(await ctx(IDS.banned));
    const input = { keyword: 'exact-input', limit: 10, offset: 3 };
    await caller.queryAgents(input);
    // The real handler supplies a dedicated original AgentModel.queryAgents(input) closure; the
    // adapter invokes it once and does not touch its managed loader under the disabled flag.
    expect(mergeAvailableAgents).toHaveBeenCalledTimes(1);
    expect(mergeAvailableAgents).toHaveBeenCalledWith(
      IDS.banned,
      { keyword: 'exact-input', limit: 10, offset: 3 },
      expect.any(Function),
      expect.any(Function),
    );
    expect(listCtor).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('aiAgent.execAgent still runs for a banned caller (guard is a no-op)', async () => {
    const caller = createCallerFactory(aiAgentRouter)(await ctx(IDS.banned));
    await caller.execAgent({ agentId: 'agt_local', prompt: 'hi' });
    expect(execAgentSpy).toHaveBeenCalledTimes(1);
  });
});
