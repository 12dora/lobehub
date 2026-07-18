/**
 * R01 regression — user-facing platform.agents must always enforce active-user,
 * independently of ENABLE_PLATFORM_ADMIN.
 *
 * The Effective Agent surface is activated by ENABLE_PLATFORM_MANAGED_AGENTS on its
 * own, so an inactive / banned / epoch-invalidated principal must be rejected on
 * procedure entry — before the resolver ever touches Agent rows — even while the
 * admin flag is OFF.
 *
 * @vitest-environment node
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
import { getTestDB } from '@/database/core/getTestDB';
import { users } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { getEnterpriseErrorBody } from '../guards/enterpriseErrors';
import { platformAgentsRouter } from './platformAgents';

let db: LobeChatDatabase;

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));

// Spy on the downstream resolver so we can prove the guard rejects *before* any
// resolver / Agent-row access. The guard's own active-user determination still runs
// against the real test DB (real banned / authInvalidatedAt rows), so caller identity
// behavior is genuinely exercised — only the post-guard resolver is stubbed.
const { getEffectiveListSpy, getEffectiveAgentSpy, resolverCtorSpy } = vi.hoisted(() => ({
  getEffectiveAgentSpy: vi.fn(async () => null),
  getEffectiveListSpy: vi.fn(async () => ({ agents: [], revision: '0'.repeat(64) })),
  resolverCtorSpy: vi.fn(),
}));

vi.mock('../services/agentCatalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    PlatformAgentEffectiveResolver: class {
      getEffectiveAgent = getEffectiveAgentSpy;
      getEffectiveList = getEffectiveListSpy;
      constructor(...ctorArgs: unknown[]) {
        resolverCtorSpy(...ctorArgs);
      }
    },
  };
});

const createCaller = createCallerFactory(platformAgentsRouter);

const IDS = {
  active: 'r01-active',
  banned: 'r01-banned',
  epoch: 'r01-epoch',
  tempBanned: 'r01-temp-banned',
} as const;

const AGENT_ID = 'r01-platform-agent';

const cleanup = async () => {
  await db.delete(users);
};

/**
 * Build a real caller context. `credentialIssuedAt` defaults to a fixed epoch so the
 * epoch-invalidation case can pin authInvalidatedAt after it deterministically.
 */
const ctx = async (
  userId: string,
  extras?: { authMethod?: 'better-auth' | 'oidc'; credentialIssuedAt?: Date | null },
) =>
  (await createContextInner({
    authMethod: extras?.authMethod ?? 'oidc',
    credentialIssuedAt:
      extras && 'credentialIssuedAt' in extras
        ? extras.credentialIssuedAt
        : new Date('2020-01-01T00:00:00.000Z'),
    userId,
  })) as never;

const expectAccessDenied = (error: unknown) => {
  const body = getEnterpriseErrorBody(error);
  expect(
    body?.code === ADMIN_ERROR_CODES.ADMIN_ACCESS_DENIED ||
      (error as { code?: string }).code === 'UNAUTHORIZED',
  ).toBe(true);
};

beforeAll(async () => {
  db = await getTestDB();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  // R01 scenario: admin OFF, managed-agents ON — the surface a user can actually reach.
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
  vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');

  await cleanup();
  await db.insert(users).values([
    { id: IDS.active },
    { banned: true, id: IDS.banned },
    { banExpires: new Date(Date.now() + 3_600_000), banned: true, id: IDS.tempBanned },
    // Credential (2020) issued before the invalidation cutoff (2021) → epoch-invalid.
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

describe('R01 — platform.agents active-user enforcement (ADMIN=0, MANAGED_AGENTS=1)', () => {
  it('rejects an inactive (banned) caller before resolver access — getEffectiveList', async () => {
    const caller = createCaller(await ctx(IDS.banned));

    try {
      await caller.getEffectiveList();
      expect.fail('expected banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }

    // Proves rejection happens before any resolver / Agent-row access.
    expect(resolverCtorSpy).not.toHaveBeenCalled();
    expect(getEffectiveListSpy).not.toHaveBeenCalled();
  });

  it('rejects a banned caller before resolver access — getEffectiveAgent', async () => {
    const caller = createCaller(await ctx(IDS.banned));

    try {
      await caller.getEffectiveAgent({ platformAgentId: AGENT_ID });
      expect.fail('expected banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }

    expect(resolverCtorSpy).not.toHaveBeenCalled();
    expect(getEffectiveAgentSpy).not.toHaveBeenCalled();
  });

  it('rejects a banned caller before resolver access — setHidden (ROOT-01 mutation)', async () => {
    const caller = createCaller(await ctx(IDS.banned));

    try {
      await caller.setHidden({ hidden: true, platformAgentId: AGENT_ID });
      expect.fail('expected banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }

    // The owner-scoped hidden write must be gated by the same active-user boundary.
    expect(resolverCtorSpy).not.toHaveBeenCalled();
  });

  it('rejects a temporarily-banned (unexpired) caller', async () => {
    const caller = createCaller(await ctx(IDS.tempBanned));

    try {
      await caller.getEffectiveList();
      expect.fail('expected temp-banned caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }

    expect(getEffectiveListSpy).not.toHaveBeenCalled();
  });

  it('rejects an epoch-invalidated caller (credential issued at/before authInvalidatedAt)', async () => {
    // OIDC/API-key path: no retained-session exception, credential predates the cutoff.
    const caller = createCaller(await ctx(IDS.epoch, { authMethod: 'oidc' }));

    try {
      await caller.getEffectiveList();
      expect.fail('expected epoch-invalid caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }

    expect(getEffectiveListSpy).not.toHaveBeenCalled();
  });

  it('rejects an anonymous caller (missing userId)', async () => {
    const caller = createCaller(await ctx(null as never));

    try {
      await caller.getEffectiveList();
      expect.fail('expected anonymous caller to be denied');
    } catch (error) {
      expectAccessDenied(error);
    }

    expect(getEffectiveListSpy).not.toHaveBeenCalled();
  });

  it('lets an active caller through to the resolver with the trusted userId', async () => {
    const caller = createCaller(await ctx(IDS.active));

    const result = await caller.getEffectiveList();

    expect(result).toEqual({ agents: [], revision: '0'.repeat(64) });
    expect(getEffectiveListSpy).toHaveBeenCalledTimes(1);
    expect(getEffectiveListSpy).toHaveBeenCalledWith(IDS.active);
    expect(resolverCtorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('R01 — enforcement does not depend on the admin flag', () => {
  it('still rejects a banned caller when ENABLE_PLATFORM_ADMIN is entirely unset', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '');
    const caller = createCaller(await ctx(IDS.banned));

    try {
      await caller.getEffectiveList();
      expect.fail('expected banned caller to be denied with admin flag unset');
    } catch (error) {
      expectAccessDenied(error);
    }

    expect(getEffectiveListSpy).not.toHaveBeenCalled();
  });
});
