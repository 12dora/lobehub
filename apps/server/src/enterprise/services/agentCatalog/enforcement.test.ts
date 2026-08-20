// @vitest-environment node
import { INBOX_SESSION_ID } from '@lobechat/const';
import { encodePlatformAgentListId } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import { getTestDB } from '@/database/core/getTestDB';
import {
  createUnmanagedResourcePolicyMap,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { agents, chatGroups, chatGroupsAgents, users, workspaces } from '@/database/schemas';
import { platformManagedResourcePolicies } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { ManagedResourcePolicyItem } from '@/types/platform/managedResources';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import {
  assertLocalAgentReadableUnderTakeover,
  isPlatformAgentTakeoverActive,
  PLATFORM_AGENT_TAKEOVER_MEMO_TTL_MS,
  resetPlatformAgentTakeoverCache,
  resetPlatformAgentTakeoverCacheForTest,
} from './enforcement';

const { getPlatformAgentIdByMaterializedAgentId, listMaterializedAgentIds } = vi.hoisted(() => ({
  getPlatformAgentIdByMaterializedAgentId: vi.fn(async () => null as string | null),
  listMaterializedAgentIds: vi.fn(async () => new Set<string>()),
}));

vi.mock('@/database/repositories/platformAgentCatalog', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    PlatformAgentCatalogRepository: class {
      getPlatformAgentIdByMaterializedAgentId = getPlatformAgentIdByMaterializedAgentId;
      listMaterializedAgentIds = listMaterializedAgentIds;
    },
  };
});

const db: LobeChatDatabase = await getTestDB();
const flagsOn = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
const USER = 'agent-takeover-user';

const publish = async (agentsPolicy: ManagedResourcePolicyItem) => {
  const model = new PlatformManagedResourcePolicyModel(db);
  await model.ensureRows();
  const policies = createUnmanagedResourcePolicyMap();
  policies.agents = agentsPolicy;
  await model.materializePublished({ policies, revision: 1 });
  resetPlatformAgentTakeoverCacheForTest();
};

const saveDraftOnly = async (agentsPolicy: ManagedResourcePolicyItem) => {
  const model = new PlatformManagedResourcePolicyModel(db);
  await model.ensureRows();
  const draft = createUnmanagedResourcePolicyMap();
  draft.agents = agentsPolicy;
  await model.replaceDraft({ draft });
  resetPlatformAgentTakeoverCacheForTest();
};

beforeEach(async () => {
  resetPlatformAgentTakeoverCacheForTest();
  getPlatformAgentIdByMaterializedAgentId.mockResolvedValue(null);
  listMaterializedAgentIds.mockResolvedValue(new Set());
  await db.delete(chatGroupsAgents);
  await db.delete(chatGroups);
  await db.delete(platformManagedResourcePolicies);
  await db.delete(agents);
  await db.delete(workspaces);
  await db.delete(users);
  await db.insert(users).values({ id: USER });
});

afterEach(async () => {
  resetPlatformAgentTakeoverCacheForTest();
  await db.delete(chatGroupsAgents);
  await db.delete(chatGroups);
  await db.delete(platformManagedResourcePolicies);
  await db.delete(agents);
  await db.delete(workspaces);
  await db.delete(users);
});

describe('isPlatformAgentTakeoverActive', () => {
  it('is false without the feature flag, and never reads the policy table', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });
    const failOnRead = new Proxy(
      {},
      {
        get() {
          throw new Error('policy table must not be read while the flag is off');
        },
      },
    ) as LobeChatDatabase;

    expect(await isPlatformAgentTakeoverActive(failOnRead, DISABLED_ENTERPRISE_FEATURE_FLAGS)).toBe(
      false,
    );
  });

  it('is false while the enforced policy is only a draft', async () => {
    await saveDraftOnly({ enforcementMode: 'enforced', managed: true });

    expect(await isPlatformAgentTakeoverActive(db, flagsOn)).toBe(false);
  });

  it('is false for the 用户自配 (observe) published policy', async () => {
    await publish({ enforcementMode: 'observe', managed: false });

    expect(await isPlatformAgentTakeoverActive(db, flagsOn)).toBe(false);
  });

  it('is false for observe-with-managed and for ui-only (UI hiding is not a runtime takeover)', async () => {
    await publish({ enforcementMode: 'observe', managed: true });
    expect(await isPlatformAgentTakeoverActive(db, flagsOn)).toBe(false);

    await publish({ enforcementMode: 'ui-only', managed: true });
    expect(await isPlatformAgentTakeoverActive(db, flagsOn)).toBe(false);
  });

  it('is false for enforced-but-not-managed', async () => {
    await publish({ enforcementMode: 'enforced', managed: false });

    expect(await isPlatformAgentTakeoverActive(db, flagsOn)).toBe(false);
  });

  it('is true only for a published managed+enforced policy', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });

    expect(await isPlatformAgentTakeoverActive(db, flagsOn)).toBe(true);
  });

  it('memoizes per db for a bounded window and re-reads once it expires', async () => {
    expect(PLATFORM_AGENT_TAKEOVER_MEMO_TTL_MS).toBeLessThanOrEqual(2000);
    await publish({ enforcementMode: 'enforced', managed: true });
    const now = vi.fn<() => number>().mockReturnValue(1000);

    expect(await isPlatformAgentTakeoverActive(db, flagsOn, now)).toBe(true);

    const model = new PlatformManagedResourcePolicyModel(db);
    await model.materializePublished({
      policies: createUnmanagedResourcePolicyMap(),
      revision: 2,
    });
    expect(await isPlatformAgentTakeoverActive(db, flagsOn, now)).toBe(true);

    now.mockReturnValue(1000 + PLATFORM_AGENT_TAKEOVER_MEMO_TTL_MS + 1);
    expect(await isPlatformAgentTakeoverActive(db, flagsOn, now)).toBe(false);
  });

  it('resetPlatformAgentTakeoverCache makes the very next read observe the new policy', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });
    const now = vi.fn<() => number>().mockReturnValue(1000);
    expect(await isPlatformAgentTakeoverActive(db, flagsOn, now)).toBe(true);

    await new PlatformManagedResourcePolicyModel(db).materializePublished({
      policies: createUnmanagedResourcePolicyMap(),
      revision: 2,
    });
    resetPlatformAgentTakeoverCache();

    expect(await isPlatformAgentTakeoverActive(db, flagsOn, now)).toBe(false);
  });

  it('fails closed: a policy read failure propagates instead of degrading to unmanaged', async () => {
    const brokenDb = {
      select: () => {
        throw new Error('policy table unavailable');
      },
    } as unknown as LobeChatDatabase;

    await expect(isPlatformAgentTakeoverActive(brokenDb, flagsOn)).rejects.toThrow(
      'policy table unavailable',
    );
  });

  it('does not cache a snapshot that completed after a publish reset', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unpublished = {
      draft: createUnmanagedResourcePolicyMap(),
      published: createUnmanagedResourcePolicyMap(),
      revision: 0,
      status: 'draft' as const,
    };
    const pending = isPlatformAgentTakeoverActive(db, flagsOn, Date.now, async () => {
      await gate;
      return unpublished;
    });
    await publish({ enforcementMode: 'enforced', managed: true });
    release();
    expect(await pending).toBe(false);
    expect(await isPlatformAgentTakeoverActive(db, flagsOn)).toBe(true);
  });
});

describe('assertLocalAgentReadableUnderTakeover', () => {
  beforeEach(() => {
    vi.stubEnv('ENABLE_PLATFORM_MANAGED_AGENTS', '1');
    resetPlatformAgentTakeoverCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const deny = (params: { identifier: string; slug?: string | null; workspaceId?: string }) =>
    assertLocalAgentReadableUnderTakeover({
      db,
      identifier: params.identifier,
      slug: params.slug,
      userId: USER,
      workspaceId: params.workspaceId,
    });

  it('is a no-op when takeover is not active', async () => {
    await expect(deny({ identifier: 'agt_user' })).resolves.toBeUndefined();
  });

  it('allows inbox slug, encoded platform ids, and builtin identities under takeover', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });

    await expect(deny({ identifier: INBOX_SESSION_ID })).resolves.toBeUndefined();
    await expect(
      deny({ identifier: 'inbox-uuid', slug: INBOX_SESSION_ID }),
    ).resolves.toBeUndefined();
    await expect(deny({ identifier: 'page-agent' })).resolves.toBeUndefined();
    await expect(
      deny({ identifier: encodePlatformAgentListId('pagt_1') }),
    ).resolves.toBeUndefined();
  });

  it('allows a materialized platform clone under takeover', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });
    getPlatformAgentIdByMaterializedAgentId.mockResolvedValue('pagt_1');

    await expect(deny({ identifier: 'agt_mat', slug: null })).resolves.toBeUndefined();
    expect(getPlatformAgentIdByMaterializedAgentId).toHaveBeenCalledWith(USER, 'agt_mat');
  });

  it('denies a user-owned local agent under takeover with RESOURCE_MANAGED_BY_PLATFORM', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });

    const error = await deny({ identifier: 'agt_user', slug: null }).then(
      () => {
        throw new Error('expected takeover to deny the user-owned agent');
      },
      (e) => e,
    );

    expect((error as { code?: string }).code).toBe('FORBIDDEN');
    expect(getEnterpriseErrorBody(error)?.code).toBe(
      MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
    );
  });

  it('allows a group supervisor identified by membership role (personal and workspace)', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });
    await db.insert(agents).values({
      id: 'agt_sup',
      title: 'Supervisor',
      userId: USER,
      virtual: true,
    });
    await db.insert(chatGroups).values({ id: 'grp_1', title: 'G', userId: USER });
    await db.insert(chatGroupsAgents).values({
      agentId: 'agt_sup',
      chatGroupId: 'grp_1',
      role: 'supervisor',
      userId: USER,
    });
    await expect(deny({ identifier: 'agt_sup', slug: null })).resolves.toBeUndefined();

    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'WS', primaryOwnerId: USER, slug: 'takeover-ws' })
      .returning();
    await db.insert(agents).values({
      id: 'agt_sup_ws',
      title: 'WS Supervisor',
      userId: USER,
      virtual: true,
      workspaceId: workspace.id,
    });
    await db.insert(chatGroups).values({
      id: 'grp_ws',
      title: 'G',
      userId: USER,
      workspaceId: workspace.id,
    });
    await db.insert(chatGroupsAgents).values({
      agentId: 'agt_sup_ws',
      chatGroupId: 'grp_ws',
      role: 'supervisor',
      userId: USER,
      workspaceId: workspace.id,
    });
    await expect(
      deny({ identifier: 'agt_sup_ws', slug: null, workspaceId: workspace.id }),
    ).resolves.toBeUndefined();
  });

  it('allows a validated heterogeneous agent (personal and workspace)', async () => {
    await publish({ enforcementMode: 'enforced', managed: true });
    await db.insert(agents).values({
      agencyConfig: { heterogeneousProvider: { type: 'claude-code' } },
      id: 'agt_hetero',
      title: 'CC',
      userId: USER,
    });
    await expect(deny({ identifier: 'agt_hetero' })).resolves.toBeUndefined();

    const [workspace] = await db
      .insert(workspaces)
      .values({ name: 'WS2', primaryOwnerId: USER, slug: 'takeover-ws2' })
      .returning();
    await db.insert(agents).values({
      agencyConfig: { heterogeneousProvider: { type: 'codex' } },
      id: 'agt_hetero_ws',
      title: 'Codex',
      userId: USER,
      workspaceId: workspace.id,
    });
    await expect(
      deny({ identifier: 'agt_hetero_ws', workspaceId: workspace.id }),
    ).resolves.toBeUndefined();
  });
});
