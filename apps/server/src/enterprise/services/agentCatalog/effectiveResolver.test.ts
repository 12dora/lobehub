import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import {
  createUnmanagedResourcePolicyMap,
  type ManagedResourcePolicySnapshot,
} from '@/database/models/platform';
import type {
  PlatformAgentCatalogRepository,
  PlatformAgentEffectiveInput,
} from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import {
  PLATFORM_AGENT_EFFECTIVE_INPUT_OVERSCAN,
  PLATFORM_AGENT_EFFECTIVE_LIST_MAX,
  PlatformAgentEffectiveResolver,
} from './effectiveResolver';
import { PlatformAgentUnavailableError } from './errors';

const config = {
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName: 'Support',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: 'Help users.',
  tags: [],
};

const flags = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
const managedPolicy = (): ManagedResourcePolicySnapshot => {
  const published = createUnmanagedResourcePolicyMap();
  published.agents = { enforcementMode: 'enforced', managed: true };
  return {
    draft: createUnmanagedResourcePolicyMap(),
    published,
    revision: 1,
    status: 'published',
  };
};

const row = (params: {
  agentId: string;
  agentKey: string;
  assignmentId: string;
  config?: typeof config;
  mode?: 'default' | 'mandatory' | 'optional';
  priority: 1 | 2 | 3;
  systemKey?: string | null;
  versionId?: string;
}): PlatformAgentEffectiveInput =>
  ({
    agent: {
      agentKey: params.agentKey,
      id: params.agentId,
      systemKey: params.systemKey ?? null,
    },
    assignment: {
      id: params.assignmentId,
      mode: params.mode ?? 'optional',
    },
    targetPriority: params.priority,
    version: {
      checksum: 'a'.repeat(64),
      config: params.config ?? config,
      id: params.versionId ?? `${params.agentId}-version`,
      version: '1.0.0',
    },
  }) as unknown as PlatformAgentEffectiveInput;

const db = {} as LobeChatDatabase;

describe('PlatformAgentEffectiveResolver', () => {
  const getSnapshot = vi.fn();
  const listEffectiveInputs = vi.fn();
  const listHiddenPlatformAgentIds = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getSnapshot.mockResolvedValue(managedPolicy());
    listEffectiveInputs.mockResolvedValue([]);
    listHiddenPlatformAgentIds.mockResolvedValue(new Set<string>());
  });

  const createResolver = (enabledFlags = flags) =>
    new PlatformAgentEffectiveResolver(db, {
      flags: enabledFlags,
      policyModel: { getSnapshot },
      repository: {
        listEffectiveInputs,
        listHiddenPlatformAgentIds,
      } as Pick<
        PlatformAgentCatalogRepository,
        'listEffectiveInputs' | 'listHiddenPlatformAgentIds'
      >,
    });

  it('effective list handles the 1000/1001 boundary', async () => {
    listEffectiveInputs.mockResolvedValue(
      Array.from({ length: PLATFORM_AGENT_EFFECTIVE_LIST_MAX + 1 }, (_, index) =>
        row({
          agentId: `agent-${index}`,
          agentKey: `key-${String(index).padStart(4, '0')}`,
          assignmentId: `asg-${index}`,
          priority: 1,
        }),
      ),
    );

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents).toHaveLength(PLATFORM_AGENT_EFFECTIVE_LIST_MAX);
    // Contract ceiling — must never exceed the wire max even when the catalog is larger.
    expect(result.agents.length).toBeLessThanOrEqual(1000);
    // Full-list path passes a bounded SQL overscan limit (never unbounded / undefined).
    expect(listEffectiveInputs).toHaveBeenCalledWith('user', {
      limit: PLATFORM_AGENT_EFFECTIVE_INPUT_OVERSCAN,
    });
  });

  it('filters hidden before the wire-cap so visible agents past the first 1000 slots survive', async () => {
    // First 1000 authorized winners are hidden optional Agents; the next 50 are visible.
    // Truncating BEFORE hidden filter would return [] — wrong. Hidden-then-slice fills the list.
    listEffectiveInputs.mockResolvedValue(
      Array.from({ length: PLATFORM_AGENT_EFFECTIVE_LIST_MAX + 50 }, (_, index) =>
        row({
          agentId: `agent-${index}`,
          agentKey: `key-${String(index).padStart(4, '0')}`,
          assignmentId: `asg-${index}`,
          mode: 'optional',
          priority: 1,
        }),
      ),
    );
    listHiddenPlatformAgentIds.mockResolvedValue(
      new Set(
        Array.from({ length: PLATFORM_AGENT_EFFECTIVE_LIST_MAX }, (_, index) => `agent-${index}`),
      ),
    );

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents).toHaveLength(50);
    expect(result.agents[0]?.platformAgentId).toBe(`agent-${PLATFORM_AGENT_EFFECTIVE_LIST_MAX}`);
  });

  it('getEffectiveAgent uses a targeted repository filter and never full-list projection', async () => {
    listEffectiveInputs.mockResolvedValue([
      row({ agentId: 'only', agentKey: 'only', assignmentId: 'asg', priority: 3 }),
    ]);

    const result = await createResolver().getEffectiveAgent('user', 'only');
    expect(result).toMatchObject({ platformAgentId: 'only' });
    expect(listEffectiveInputs).toHaveBeenCalledWith('user', { platformAgentId: 'only' });
    // Single-agent path must not re-enter with an unfiltered full catalog scan.
    expect(listEffectiveInputs).toHaveBeenCalledTimes(1);
  });

  it('does not read policy, Agent, or hidden tables while the feature is disabled', async () => {
    const result = await createResolver(DEFAULT_ENTERPRISE_FEATURE_FLAGS).getEffectiveList('user');
    expect(result.agents).toEqual([]);
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(listEffectiveInputs).not.toHaveBeenCalled();
    expect(listHiddenPlatformAgentIds).not.toHaveBeenCalled();
  });

  // REWORK-5: a raw driver / SQL error must never cross the read boundary — it is redacted to the
  // stable, detail-free PlatformAgentUnavailableError carrying no SQL / constraint / identifier.
  describe('DB error redaction (REWORK-5)', () => {
    const rawDbError = Object.assign(
      new Error(
        'error: relation "platform_agent_assignments" does not exist for user super-admin-42',
      ),
      { code: '42P01', constraint: 'platform_agents_agent_key_unique', severity: 'ERROR' },
    );

    const expectRedacted = async (run: () => Promise<unknown>) => {
      const error = await run().then(
        () => null,
        (e) => e,
      );
      expect(error).toBeInstanceOf(PlatformAgentUnavailableError);
      const serialized = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(serialized).not.toMatch(/platform_agent|does not exist|super-admin|42P01|ERROR/);
    };

    it('redacts a raw error from getEffectiveList', async () => {
      listEffectiveInputs.mockRejectedValueOnce(rawDbError);
      await expectRedacted(() => createResolver().getEffectiveList('user'));
    });

    it('redacts a raw error from getEffectiveAgent', async () => {
      listEffectiveInputs.mockRejectedValueOnce(rawDbError);
      await expectRedacted(() => createResolver().getEffectiveAgent('user', 'agent-1'));
    });

    it('redacts a raw error from beginOperation', async () => {
      listEffectiveInputs.mockRejectedValueOnce(rawDbError);
      await expectRedacted(() => createResolver().beginOperation('user', 'agent-1'));
    });
  });

  it('does not read Agent or hidden tables while the published policy is unmanaged', async () => {
    getSnapshot.mockResolvedValue({
      ...managedPolicy(),
      published: createUnmanagedResourcePolicyMap(),
    });
    expect((await createResolver().getEffectiveList('user')).agents).toEqual([]);
    expect(listEffectiveInputs).not.toHaveBeenCalled();
    expect(listHiddenPlatformAgentIds).not.toHaveBeenCalled();
  });

  it('applies user > global role > global priority and de-duplicates Agent/system keys', async () => {
    listEffectiveInputs.mockResolvedValue([
      row({ agentId: 'same', agentKey: 'same', assignmentId: 'global', priority: 1 }),
      row({
        agentId: 'inbox-low',
        agentKey: 'inbox-low',
        assignmentId: 'role',
        priority: 2,
        systemKey: 'default-inbox',
      }),
      row({
        agentId: 'inbox-high',
        agentKey: 'inbox-high',
        assignmentId: 'user',
        mode: 'mandatory',
        priority: 3,
        systemKey: 'default-inbox',
      }),
      row({
        agentId: 'same',
        agentKey: 'same',
        assignmentId: 'user-same',
        mode: 'default',
        priority: 3,
        versionId: 'same-user-version',
      }),
    ]);

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents).toHaveLength(2);
    expect(result.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          distribution: 'mandatory',
          platformAgentId: 'inbox-high',
          systemKey: 'default-inbox',
        }),
        expect.objectContaining({
          distribution: 'default',
          platformAgentId: 'same',
          versionId: 'same-user-version',
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('targetId');
    expect(JSON.stringify(result)).not.toContain('dependencySnapshot');
  });

  it('returns only an Agent assigned to the requesting user', async () => {
    listEffectiveInputs.mockImplementation(async (_userId, filter) => {
      if (filter?.platformAgentId === 'visible') {
        return [
          row({ agentId: 'visible', agentKey: 'visible', assignmentId: 'global', priority: 1 }),
        ];
      }
      return [];
    });
    await expect(createResolver().getEffectiveAgent('user', 'visible')).resolves.toMatchObject({
      platformAgentId: 'visible',
    });
    await expect(createResolver().getEffectiveAgent('user', 'missing')).resolves.toBeNull();
  });

  // R1: mandatory ignores hidden; default / optional respect the requesting user's hidden set.
  describe('owner-scoped hidden filtering (R1)', () => {
    beforeEach(() => {
      listEffectiveInputs.mockResolvedValue([
        row({
          agentId: 'mand',
          agentKey: 'mand',
          assignmentId: 'a1',
          mode: 'mandatory',
          priority: 3,
        }),
        row({ agentId: 'def', agentKey: 'def', assignmentId: 'a2', mode: 'default', priority: 3 }),
        row({ agentId: 'opt', agentKey: 'opt', assignmentId: 'a3', mode: 'optional', priority: 3 }),
      ]);
    });

    it('keeps every Agent visible when nothing is hidden', async () => {
      const result = await createResolver().getEffectiveList('user');
      expect(result.agents.map((agent) => agent.platformAgentId).sort()).toEqual([
        'def',
        'mand',
        'opt',
      ]);
    });

    it('hides default / optional but never mandatory', async () => {
      listHiddenPlatformAgentIds.mockResolvedValue(new Set(['mand', 'def', 'opt']));
      const result = await createResolver().getEffectiveList('user');
      expect(result.agents.map((agent) => agent.platformAgentId)).toEqual(['mand']);
    });

    it('reads the hidden set strictly for the requesting user', async () => {
      await createResolver().getEffectiveList('user-a');
      expect(listHiddenPlatformAgentIds).toHaveBeenCalledWith('user-a');
    });
  });

  // R2: operation handle captures once and replays a copy-safe, version-pinned snapshot.
  describe('operation handle (R2)', () => {
    it('returns a deep-frozen snapshot that a caller cannot mutate or pollute', async () => {
      listEffectiveInputs.mockResolvedValue([
        row({ agentId: 'snap', agentKey: 'snap', assignmentId: 'a', priority: 1 }),
      ]);
      const handle = await createResolver().beginOperation('user', 'snap');
      const snapshot = handle!.getSnapshot();
      expect(snapshot).toMatchObject({
        checksum: 'a'.repeat(64),
        platformAgentId: 'snap',
        versionId: 'snap-version',
      });
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.config)).toBe(true);
      // Deep clone: mutating the source config does not change the captured snapshot.
      expect(snapshot.config).not.toBe(config);
      expect(() => {
        (snapshot.config as { displayName: string }).displayName = 'tampered';
      }).toThrow();
      expect(snapshot.config.displayName).toBe('Support');
      expect(JSON.stringify(snapshot)).not.toContain('dependencySnapshot');
    });

    it('captures exactly once per handle and replays the same value on repeated reads', async () => {
      listEffectiveInputs.mockResolvedValue([
        row({ agentId: 'once', agentKey: 'once', assignmentId: 'a', priority: 1 }),
      ]);
      const handle = await createResolver().beginOperation('user', 'once');
      expect(listEffectiveInputs).toHaveBeenCalledTimes(1);
      const first = handle!.getSnapshot();
      const second = handle!.getSnapshot();
      const third = handle!.getSnapshot();
      // No re-resolution: still one repository call, and the same frozen value every time.
      expect(listEffectiveInputs).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it('pins the version captured at begin even after a new publish; a new handle sees v2', async () => {
      listEffectiveInputs.mockResolvedValue([
        row({ agentId: 'ver', agentKey: 'ver', assignmentId: 'a', priority: 1, versionId: 'v1' }),
      ]);
      const resolver = createResolver();
      const operationA = await resolver.beginOperation('user', 'ver');

      // Publish v2 (the current pointer now resolves to a new version).
      listEffectiveInputs.mockResolvedValue([
        row({ agentId: 'ver', agentKey: 'ver', assignmentId: 'a', priority: 1, versionId: 'v2' }),
      ]);
      const operationB = await resolver.beginOperation('user', 'ver');

      // The handle replays its captured version no matter how often it is read.
      expect(operationA!.getSnapshot().versionId).toBe('v1');
      expect(operationA!.getSnapshot().versionId).toBe('v1');
      expect(operationB!.getSnapshot().versionId).toBe('v2');
    });

    it('returns null for an Agent the user is not entitled to', async () => {
      listEffectiveInputs.mockResolvedValue([]);
      expect(await createResolver().beginOperation('user', 'nope')).toBeNull();
    });
  });

  describe('system operation handle (PR-051)', () => {
    it('does not read policy or catalog state while the feature is disabled', async () => {
      const result = await createResolver(DEFAULT_ENTERPRISE_FEATURE_FLAGS).beginSystemOperation(
        'user',
        'default-inbox',
      );
      expect(result).toBeNull();
      expect(getSnapshot).not.toHaveBeenCalled();
      expect(listEffectiveInputs).not.toHaveBeenCalled();
      expect(listHiddenPlatformAgentIds).not.toHaveBeenCalled();
    });

    it('resolves default-inbox from the authorized set even when its list tile is hidden', async () => {
      listEffectiveInputs.mockResolvedValue([
        row({
          agentId: 'inbox',
          agentKey: 'inbox',
          assignmentId: 'a',
          mode: 'optional',
          priority: 3,
          systemKey: 'default-inbox',
          versionId: 'v2',
        }),
      ]);
      listHiddenPlatformAgentIds.mockResolvedValue(new Set(['inbox']));

      const handle = await createResolver().beginSystemOperation('user', 'default-inbox');
      expect(handle?.getSnapshot()).toMatchObject({ platformAgentId: 'inbox', versionId: 'v2' });
      // System roles deliberately ignore the list-only hidden preference.
      expect(listHiddenPlatformAgentIds).not.toHaveBeenCalled();
    });

    it('pins V2 for an existing operation while a new operation sees rollback V1', async () => {
      listEffectiveInputs.mockResolvedValue([
        row({
          agentId: 'inbox',
          agentKey: 'inbox',
          assignmentId: 'a',
          priority: 3,
          systemKey: 'default-inbox',
          versionId: 'v2',
        }),
      ]);
      const resolver = createResolver();
      const oldOperation = await resolver.beginSystemOperation('user', 'default-inbox');

      listEffectiveInputs.mockResolvedValue([
        row({
          agentId: 'inbox',
          agentKey: 'inbox',
          assignmentId: 'a',
          priority: 3,
          systemKey: 'default-inbox',
          versionId: 'v1',
        }),
      ]);
      const newOperation = await resolver.beginSystemOperation('user', 'default-inbox');

      expect(oldOperation?.getSnapshot().versionId).toBe('v2');
      expect(newOperation?.getSnapshot().versionId).toBe('v1');
    });
  });
});
