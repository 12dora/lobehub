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
  PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
  PLATFORM_AGENT_EFFECTIVE_LIST_MAX,
  type PlatformAgentEffectiveInputsFilter,
  PlatformAgentEffectiveResolver,
  projectFirstWinnersThenHide,
  sliceEffectiveInputsByKeyset,
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
  /** ISO / Date — used for winner list keyset (createdAt DESC, id DESC). */
  createdAt?: Date | string;
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
      createdAt: params.createdAt ?? new Date(0),
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

/** Newest-first createdAt so index order matches previous key-${index} expectations. */
const createdAtForIndex = (index: number, total: number) =>
  new Date(Date.UTC(2020, 0, 1) + (total - index) * 1000);

const db = {} as LobeChatDatabase;

/**
 * Faithful in-memory stand-in for production full-list SQL
 * (DISTINCT ON first-winner → hidden filter → createdAt DESC keyset).
 * Scale regressions exercise the real SQL path in the *.pg.test.ts suite — not this helper.
 */
const productionWinnerPageQuery =
  (allRows: PlatformAgentEffectiveInput[], hidden: ReadonlySet<string> = new Set()) =>
  async (
    _db: LobeChatDatabase,
    _userId: string,
    filter?: PlatformAgentEffectiveInputsFilter,
  ): Promise<PlatformAgentEffectiveInput[]> =>
    sliceEffectiveInputsByKeyset(allRows, { ...filter, hidden });

describe('PlatformAgentEffectiveResolver', () => {
  const getSnapshot = vi.fn();
  const listEffectiveInputs = vi.fn();
  const listHiddenPlatformAgentIds = vi.fn();
  const queryEffectiveInputsPage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getSnapshot.mockResolvedValue(managedPolicy());
    listEffectiveInputs.mockResolvedValue([]);
    listHiddenPlatformAgentIds.mockResolvedValue(new Set<string>());
    // Full-list defaults to empty production pages (not the repository surface).
    queryEffectiveInputsPage.mockResolvedValue([]);
  });

  const createResolver = (enabledFlags = flags) =>
    new PlatformAgentEffectiveResolver(db, {
      flags: enabledFlags,
      policyModel: { getSnapshot },
      queryEffectiveInputsPage,
      repository: {
        listEffectiveInputs,
        listHiddenPlatformAgentIds,
      } as Pick<
        PlatformAgentCatalogRepository,
        'listEffectiveInputs' | 'listHiddenPlatformAgentIds'
      >,
    });

  describe('sliceEffectiveInputsByKeyset (winner pagination contract)', () => {
    it('returns first-winner then createdAt DESC pages and advances strictly after the cursor', () => {
      const total = 5;
      const allRows = Array.from({ length: total }, (_, index) =>
        row({
          agentId: `agent-${index}`,
          agentKey: `key-${index}`,
          assignmentId: `asg-${index}`,
          createdAt: createdAtForIndex(index, total),
          priority: 1,
        }),
      );
      // Winner order: createdAt DESC → asg-0, asg-1, ... (newest first via createdAtForIndex)
      const page1 = sliceEffectiveInputsByKeyset(allRows, { limit: 2 });
      expect(page1.map((r) => r.assignment.id)).toEqual(['asg-0', 'asg-1']);

      const page2 = sliceEffectiveInputsByKeyset(allRows, {
        cursor: {
          createdAt: page1[1]!.assignment.createdAt,
          id: page1[1]!.assignment.id,
        },
        limit: 2,
      });
      expect(page2.map((r) => r.assignment.id)).toEqual(['asg-2', 'asg-3']);
      expect(page2[0]?.assignment.id).not.toBe(page1[0]?.assignment.id);
    });

    it('suppresses a whole key when the first winner is hidden (no lower-priority resurfacing)', () => {
      const rows = [
        row({
          agentId: 'dup',
          agentKey: 'dup',
          assignmentId: 'asg-user',
          createdAt: new Date('2024-06-01T00:00:00Z'),
          mode: 'optional',
          priority: 3,
        }),
        row({
          agentId: 'dup',
          agentKey: 'dup',
          assignmentId: 'asg-global',
          createdAt: new Date('2024-01-01T00:00:00Z'),
          mode: 'optional',
          priority: 1,
        }),
        row({
          agentId: 'other',
          agentKey: 'other',
          assignmentId: 'asg-other',
          createdAt: new Date('2024-03-01T00:00:00Z'),
          mode: 'optional',
          priority: 1,
        }),
      ];
      // First winner for "dup" is the user assignment (priority 3); hidden → key fully excluded.
      const page = sliceEffectiveInputsByKeyset(rows, {
        hidden: new Set(['dup']),
        limit: 10,
      });
      expect(page.map((r) => r.agent.id)).toEqual(['other']);
    });

    it('returns empty when the cursor is past the last row', () => {
      const allRows = [
        row({
          agentId: 'a',
          agentKey: 'a',
          assignmentId: 'asg-a',
          createdAt: new Date('2020-01-01T00:00:00Z'),
          priority: 1,
        }),
      ];
      expect(
        sliceEffectiveInputsByKeyset(allRows, {
          cursor: { createdAt: new Date('1970-01-01T00:00:00Z'), id: 'asg-z' },
          limit: 10,
        }),
      ).toEqual([]);
    });
  });

  it('effective list handles the 1000/1001 boundary', async () => {
    const total = PLATFORM_AGENT_EFFECTIVE_LIST_MAX + 1;
    const allRows = Array.from({ length: total }, (_, index) =>
      row({
        agentId: `agent-${index}`,
        agentKey: `key-${String(index).padStart(4, '0')}`,
        assignmentId: `asg-${index}`,
        createdAt: createdAtForIndex(index, total),
        priority: 1,
      }),
    );
    queryEffectiveInputsPage.mockImplementation(productionWinnerPageQuery(allRows));

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents).toHaveLength(PLATFORM_AGENT_EFFECTIVE_LIST_MAX);
    expect(result.agents.length).toBeLessThanOrEqual(1000);
    expect(listEffectiveInputs).not.toHaveBeenCalled();
    expect(queryEffectiveInputsPage).toHaveBeenCalledWith(db, 'user', {
      cursor: undefined,
      limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
    });
  });

  it('filters hidden before the wire-cap so visible agents past the first 1000 slots survive', async () => {
    // First 1000 authorized winners are hidden optional Agents; the next 50 are visible.
    const total = PLATFORM_AGENT_EFFECTIVE_LIST_MAX + 50;
    const allRows = Array.from({ length: total }, (_, index) =>
      row({
        agentId: `agent-${index}`,
        agentKey: `key-${String(index).padStart(4, '0')}`,
        assignmentId: `asg-${index}`,
        createdAt: createdAtForIndex(index, total),
        mode: 'optional',
        priority: 1,
      }),
    );
    const hidden = new Set(
      Array.from({ length: PLATFORM_AGENT_EFFECTIVE_LIST_MAX }, (_, index) => `agent-${index}`),
    );
    queryEffectiveInputsPage.mockImplementation(productionWinnerPageQuery(allRows, hidden));

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents).toHaveLength(50);
    expect(result.agents[0]?.platformAgentId).toBe(`agent-${PLATFORM_AGENT_EFFECTIVE_LIST_MAX}`);
  });

  it('pages with keyset cursor past the first batch when leading rows are hidden', async () => {
    const hiddenLead = PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH + 200;
    const visibleTail = 30;
    const total = hiddenLead + visibleTail;
    const allRows = Array.from({ length: total }, (_, index) =>
      row({
        agentId: `agent-${index}`,
        agentKey: `key-${String(index).padStart(4, '0')}`,
        assignmentId: `asg-${index}`,
        createdAt: createdAtForIndex(index, total),
        mode: 'optional',
        priority: 1,
      }),
    );
    const hidden = new Set(Array.from({ length: hiddenLead }, (_, index) => `agent-${index}`));
    queryEffectiveInputsPage.mockImplementation(productionWinnerPageQuery(allRows, hidden));

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents).toHaveLength(visibleTail);
    expect(result.agents[0]?.platformAgentId).toBe(`agent-${hiddenLead}`);
    // Visible winners fit in one page after SQL-level hidden filter — at least one call.
    expect(queryEffectiveInputsPage.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(listEffectiveInputs).not.toHaveBeenCalled();
    const firstFilter = queryEffectiveInputsPage.mock.calls[0]?.[2] as
      PlatformAgentEffectiveInputsFilter | undefined;
    expect(firstFilter?.cursor).toBeUndefined();
    expect(firstFilter?.limit).toBe(PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH);
  });

  it('fills the wire max from a single winner page when BATCH equals MAX', async () => {
    // Winner-level SQL returns up to BATCH unique visible winners; with BATCH === MAX the
    // list completes in one page. Cursor multi-page is covered by queryVisibleWinnerPage
    // (real SQL) when more winners exist than a single limit.
    const total = PLATFORM_AGENT_EFFECTIVE_LIST_MAX + 50;
    const allRows = Array.from({ length: total }, (_, index) =>
      row({
        agentId: `agent-${index}`,
        agentKey: `key-${String(index).padStart(4, '0')}`,
        assignmentId: `asg-${index}`,
        createdAt: createdAtForIndex(index, total),
        mode: 'optional',
        priority: 1,
      }),
    );
    queryEffectiveInputsPage.mockImplementation(productionWinnerPageQuery(allRows));

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents).toHaveLength(PLATFORM_AGENT_EFFECTIVE_LIST_MAX);
    expect(queryEffectiveInputsPage).toHaveBeenCalledTimes(1);
    expect(queryEffectiveInputsPage).toHaveBeenCalledWith(db, 'user', {
      cursor: undefined,
      limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
    });
  });

  it('stops without looping when production keyset SQL ignores the cursor', async () => {
    const total = 3_000;
    const allRows = Array.from({ length: total }, (_, index) =>
      row({
        agentId: `agent-${index}`,
        agentKey: `key-${String(index).padStart(4, '0')}`,
        assignmentId: `asg-${index}`,
        createdAt: createdAtForIndex(index, total),
        mode: 'optional',
        priority: 1,
      }),
    );
    queryEffectiveInputsPage.mockImplementation(async (_db, _userId, filter) => {
      // Ignore cursor — always the first page of winners.
      const limit = filter?.limit ?? allRows.length;
      return productionWinnerPageQuery(allRows)(_db, _userId, { limit });
    });

    const result = await createResolver().getEffectiveList('user');
    expect(queryEffectiveInputsPage.mock.calls.length).toBeLessThanOrEqual(2);
    expect(result.agents).toHaveLength(PLATFORM_AGENT_EFFECTIVE_LIST_MAX);
    // Without cursor advance, only the first batch of winners is reachable.
    expect(
      result.agents.every((a) => {
        const n = Number(a.platformAgentId.replace('agent-', ''));
        return n < PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH;
      }),
    ).toBe(true);
  });

  it('de-dupes multi-assignment rows so six matches for one agent still leave room for others', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, index) =>
        row({
          agentId: 'shared',
          agentKey: 'shared',
          assignmentId: `asg-shared-${index}`,
          createdAt: new Date(`2024-01-0${index + 1}T00:00:00Z`),
          priority: 3,
        }),
      ),
      row({
        agentId: 'other',
        agentKey: 'other',
        assignmentId: 'asg-other',
        createdAt: new Date('2023-01-01T00:00:00Z'),
        priority: 1,
      }),
    ];
    queryEffectiveInputsPage.mockImplementation(productionWinnerPageQuery(rows));

    const result = await createResolver().getEffectiveList('user');
    expect(result.agents.map((agent) => agent.platformAgentId)).toEqual(['shared', 'other']);
  });

  it('first-winner-then-hide never resurfaces a lower-priority duplicate (F5)', () => {
    const rows = [
      row({
        agentId: 'dup',
        agentKey: 'dup',
        assignmentId: 'high',
        createdAt: new Date('2024-06-01'),
        mode: 'optional',
        priority: 3,
      }),
      row({
        agentId: 'dup',
        agentKey: 'dup',
        assignmentId: 'low',
        createdAt: new Date('2024-01-01'),
        mode: 'optional',
        priority: 1,
      }),
    ];
    // Hide-then-dedupe would incorrectly keep the low-priority row — lock first-winner-then-hide.
    const visible = projectFirstWinnersThenHide(rows, new Set(['dup']));
    expect(visible).toEqual([]);
  });

  it('getEffectiveAgent uses a targeted repository filter and never full-list projection', async () => {
    listEffectiveInputs.mockResolvedValue([
      row({ agentId: 'only', agentKey: 'only', assignmentId: 'asg', priority: 3 }),
    ]);

    const result = await createResolver().getEffectiveAgent('user', 'only');
    expect(result).toMatchObject({ platformAgentId: 'only' });
    expect(listEffectiveInputs).toHaveBeenCalledWith('user', { platformAgentId: 'only' });
    expect(listEffectiveInputs).toHaveBeenCalledTimes(1);
  });

  it('does not read policy, Agent, or hidden tables while the feature is disabled', async () => {
    const result = await createResolver(DEFAULT_ENTERPRISE_FEATURE_FLAGS).getEffectiveList('user');
    expect(result.agents).toEqual([]);
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(listEffectiveInputs).not.toHaveBeenCalled();
    expect(queryEffectiveInputsPage).not.toHaveBeenCalled();
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
      queryEffectiveInputsPage.mockRejectedValueOnce(rawDbError);
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
    expect(queryEffectiveInputsPage).not.toHaveBeenCalled();
    expect(listHiddenPlatformAgentIds).not.toHaveBeenCalled();
  });

  it('applies user > global role > global priority and de-duplicates Agent/system keys', async () => {
    // Full-list mock must return already-winner-projected rows (production SQL contract).
    const raw = [
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
    ];
    queryEffectiveInputsPage.mockImplementation(productionWinnerPageQuery(raw));

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
  // Full-list production SQL applies hidden after first-winner; mocks must do the same.
  describe('owner-scoped hidden filtering (R1)', () => {
    const catalog = [
      row({
        agentId: 'mand',
        agentKey: 'mand',
        assignmentId: 'a1',
        createdAt: new Date('2024-03-01'),
        mode: 'mandatory',
        priority: 3,
      }),
      row({
        agentId: 'def',
        agentKey: 'def',
        assignmentId: 'a2',
        createdAt: new Date('2024-02-01'),
        mode: 'default',
        priority: 3,
      }),
      row({
        agentId: 'opt',
        agentKey: 'opt',
        assignmentId: 'a3',
        createdAt: new Date('2024-01-01'),
        mode: 'optional',
        priority: 3,
      }),
    ];

    it('keeps every Agent visible when nothing is hidden', async () => {
      queryEffectiveInputsPage.mockImplementation(productionWinnerPageQuery(catalog));
      const result = await createResolver().getEffectiveList('user');
      expect(result.agents.map((agent) => agent.platformAgentId).sort()).toEqual([
        'def',
        'mand',
        'opt',
      ]);
    });

    it('hides default / optional but never mandatory', async () => {
      queryEffectiveInputsPage.mockImplementation(
        productionWinnerPageQuery(catalog, new Set(['mand', 'def', 'opt'])),
      );
      const result = await createResolver().getEffectiveList('user');
      expect(result.agents.map((agent) => agent.platformAgentId)).toEqual(['mand']);
    });

    it('full-list path invokes production winner SQL with the requesting userId', async () => {
      queryEffectiveInputsPage.mockImplementation(productionWinnerPageQuery(catalog));
      await createResolver().getEffectiveList('user-a');
      expect(queryEffectiveInputsPage).toHaveBeenCalledWith(
        db,
        'user-a',
        expect.objectContaining({ limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH }),
      );
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

      listEffectiveInputs.mockResolvedValue([
        row({ agentId: 'ver', agentKey: 'ver', assignmentId: 'a', priority: 1, versionId: 'v2' }),
      ]);
      const operationB = await resolver.beginOperation('user', 'ver');

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
