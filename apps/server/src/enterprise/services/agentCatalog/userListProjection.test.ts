import type {
  PlatformAgentAssignmentMode,
  PlatformAgentSystemKey,
  SidebarAgentItem,
} from '@lobechat/types';
import { encodePlatformAgentListId } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { DISABLED_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import type { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import type { PlatformAgentEffectiveResolver } from './effectiveResolver';
import { PlatformAgentUserListService, type UnifiedAvailableAgentItem } from './userListProjection';

const flagsOn = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
const flagsOff = { ...DISABLED_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: false };

const effectiveAgent = (
  platformAgentId: string,
  distribution: PlatformAgentAssignmentMode,
  displayName = platformAgentId,
  description: string | null = null,
  systemKey: PlatformAgentSystemKey | null = null,
) => ({
  agentKey: platformAgentId,
  checksum: 'a'.repeat(64),
  config: {
    avatar: null,
    backgroundColor: null,
    description,
    displayName,
    modelParameters: {},
    openingMessage: null,
    openingQuestions: [],
    systemRole: 'help',
    tags: [],
  },
  distribution,
  mutable: false as const,
  platformAgentId,
  source: 'platform' as const,
  systemKey,
  version: '1.0.0',
  versionId: `${platformAgentId}-v1`,
});

const makeService = (params: {
  builtinInboxId?: string;
  effective?: ReturnType<typeof effectiveAgent>[];
  flags?: typeof flagsOn;
  isTakeoverActive?: boolean;
  materialized?: string[];
  workspaceId?: string;
}) => {
  const getEffectiveList = vi.fn(async () => ({
    agents: params.effective ?? [],
    revision: 'r',
  }));
  const listMaterializedAgentIds = vi.fn(async () => new Set(params.materialized ?? []));
  const defaultInbox = params.effective?.find(({ systemKey }) => systemKey === 'default-inbox');
  const builtinInboxId = params.builtinInboxId ?? 'builtin-inbox-id';
  const loadBuiltinInbox = vi.fn(async () => ({
    avatar: defaultInbox?.config.avatar ?? null,
    backgroundColor: defaultInbox?.config.backgroundColor ?? null,
    description: defaultInbox?.config.description ?? 'Legacy description',
    id: builtinInboxId,
    platform: defaultInbox
      ? {
          distribution: defaultInbox.distribution,
          managed: true as const,
          source: 'platform' as const,
        }
      : undefined,
    title: defaultInbox?.config.displayName ?? 'Legacy inbox',
  }));
  const service = new PlatformAgentUserListService({} as LobeChatDatabase, params.workspaceId, {
    flags: params.flags ?? flagsOn,
    // Existing union tests stay on the non-takeover path unless opted in.
    isTakeoverActive: async () => params.isTakeoverActive ?? false,
    loadBuiltinInbox,
    repository: { listMaterializedAgentIds } as unknown as PlatformAgentCatalogRepository,
    resolver: { getEffectiveList } as unknown as Pick<
      PlatformAgentEffectiveResolver,
      'getEffectiveList'
    >,
  });
  return { getEffectiveList, listMaterializedAgentIds, loadBuiltinInbox, service };
};

// Simulates the SQL-side local pagination the router delegates to AgentModel.queryAgents.
const localLoader =
  (dataset: UnifiedAvailableAgentItem[]) =>
  async (p: { excludeAgentIds: string[]; keyword?: string; limit: number; offset: number }) => {
    const filtered = dataset
      .filter((item) => !p.excludeAgentIds.includes(item.id))
      .filter((item) =>
        p.keyword ? (item.title ?? '').toLowerCase().includes(p.keyword.toLowerCase()) : true,
      );
    return filtered.slice(p.offset, p.offset + p.limit);
  };

const localItem = (id: string, title: string): UnifiedAvailableAgentItem => ({
  avatar: null,
  backgroundColor: null,
  description: null,
  id,
  title,
});

const unusedLegacyLoader = async (): Promise<UnifiedAvailableAgentItem[]> => [];

describe('PlatformAgentUserListService', () => {
  describe('flag off', () => {
    it('returns the legacy local-only result with zero catalog access', async () => {
      const { service, getEffectiveList, listMaterializedAgentIds, loadBuiltinInbox } = makeService(
        {
          flags: flagsOff,
        },
      );
      const loadLocal = vi.fn(localLoader([localItem('agt_1', 'Local One')]));
      const exactLegacyResult = [localItem('agt_legacy', 'Legacy exact')];
      const loadLegacy = vi.fn(async () => exactLegacyResult);

      const result = await service.mergeAvailableAgents(
        'user-a',
        { limit: 10, offset: 0 },
        loadLocal,
        loadLegacy,
      );

      expect(result).toBe(exactLegacyResult);
      expect(loadLegacy).toHaveBeenCalledOnce();
      expect(loadLocal).not.toHaveBeenCalled();
      expect(loadBuiltinInbox).not.toHaveBeenCalled();
      expect(getEffectiveList).not.toHaveBeenCalled();
      expect(listMaterializedAgentIds).not.toHaveBeenCalled();
    });

    it('sidebar merge returns the base unchanged and never queries the catalog', async () => {
      const { service, getEffectiveList, listMaterializedAgentIds, loadBuiltinInbox } = makeService(
        {
          flags: flagsOff,
        },
      );
      const base = {
        groups: [],
        pinned: [],
        privateGroups: [],
        privateUngrouped: [],
        ungrouped: [
          {
            id: 'agt_1',
            pinned: false,
            title: 'Local',
            type: 'agent' as const,
            updatedAt: new Date(),
          },
        ],
      };
      expect(await service.mergeSidebarList('user-a', base)).toBe(base);
      expect(loadBuiltinInbox).not.toHaveBeenCalled();
      expect(getEffectiveList).not.toHaveBeenCalled();
      expect(listMaterializedAgentIds).not.toHaveBeenCalled();
    });

    it('search returns the same base value with zero builtin/catalog access', async () => {
      const { service, getEffectiveList, listMaterializedAgentIds, loadBuiltinInbox } = makeService(
        {
          flags: flagsOff,
        },
      );
      const base: SidebarAgentItem[] = [];

      expect(await service.mergeSearchResults('user-a', base, 'needle')).toBe(base);
      expect(loadBuiltinInbox).not.toHaveBeenCalled();
      expect(getEffectiveList).not.toHaveBeenCalled();
      expect(listMaterializedAgentIds).not.toHaveBeenCalled();
    });

    it('threads the explicit workspace id into the builtin loader', async () => {
      const { service, loadBuiltinInbox } = makeService({ workspaceId: 'workspace-a' });

      await service.mergeSidebarList('user-a', {
        groups: [],
        pinned: [],
        privateGroups: [],
        privateUngrouped: [],
        ungrouped: [],
      });

      expect(loadBuiltinInbox).toHaveBeenCalledWith('user-a', 'workspace-a');
    });
  });

  describe('mergeAvailableAgents (picker)', () => {
    it('keeps one stable builtin inbox identity and removes the encoded default-inbox duplicate', async () => {
      const defaultInbox = effectiveAgent(
        'platform-inbox',
        'mandatory',
        'Managed inbox',
        null,
        'default-inbox',
      );
      const { service, listMaterializedAgentIds } = makeService({
        builtinInboxId: 'builtin-inbox-id',
        effective: [defaultInbox, effectiveAgent('p1', 'optional')],
        materialized: ['builtin-inbox-id', 'agt_duplicate'],
      });
      const result = await service.mergeAvailableAgents(
        'user-a',
        { limit: 10, offset: 0 },
        localLoader([
          localItem('builtin-inbox-id', 'Inbox'),
          localItem('agt_duplicate', 'Duplicate'),
          localItem('agt_keep', 'Keep'),
        ]),
        unusedLegacyLoader,
      );

      expect(result.map(({ id }) => id)).toEqual([
        'builtin-inbox-id',
        encodePlatformAgentListId('p1'),
        'agt_keep',
      ]);
      expect(result.map(({ id }) => id)).not.toContain(encodePlatformAgentListId('platform-inbox'));
      expect(listMaterializedAgentIds).toHaveBeenCalledWith('user-a');
    });

    it('places platform items first, then local, in a single non-overlapping window', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'mandatory'), effectiveAgent('p2', 'default')],
      });
      const result = await service.mergeAvailableAgents(
        'user-a',
        { limit: 10, offset: 0 },
        localLoader([localItem('agt_1', 'Local One'), localItem('agt_2', 'Local Two')]),
        unusedLegacyLoader,
      );
      expect(result.map((r) => r.id)).toEqual([
        'builtin-inbox-id',
        encodePlatformAgentListId('p1'),
        encodePlatformAgentListId('p2'),
        'agt_1',
        'agt_2',
      ]);
      expect(result[0].platform).toBeUndefined();
      expect(result[1].platform).toEqual({
        distribution: 'mandatory',
        managed: true,
        source: 'platform',
      });
    });

    it('paginates across the boundary without dropping or duplicating items', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'mandatory'), effectiveAgent('p2', 'optional')],
      });
      const local = [localItem('agt_1', 'L1'), localItem('agt_2', 'L2'), localItem('agt_3', 'L3')];

      // Page size 2 across [inbox, p1, p2, agt_1, agt_2, agt_3].
      const page1 = await service.mergeAvailableAgents(
        'u',
        { limit: 2, offset: 0 },
        localLoader(local),
        unusedLegacyLoader,
      );
      const page2 = await service.mergeAvailableAgents(
        'u',
        { limit: 2, offset: 2 },
        localLoader(local),
        unusedLegacyLoader,
      );
      const page3 = await service.mergeAvailableAgents(
        'u',
        { limit: 2, offset: 4 },
        localLoader(local),
        unusedLegacyLoader,
      );

      expect(page1.map((r) => r.id)).toEqual(['builtin-inbox-id', encodePlatformAgentListId('p1')]);
      expect(page2.map((r) => r.id)).toEqual([encodePlatformAgentListId('p2'), 'agt_1']);
      expect(page3.map((r) => r.id)).toEqual(['agt_2', 'agt_3']);
    });

    it('page total matches inbox + platform + local from one projection', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'mandatory')],
      });
      const loadLocal = vi.fn(localLoader([localItem('agt_1', 'L1'), localItem('agt_2', 'L2')]));
      const countLocal = vi.fn(async () => 2);
      const page = await service.mergeAvailableAgentsPage(
        'u',
        { limit: 10, offset: 0 },
        loadLocal,
        unusedLegacyLoader,
        async () => 99,
        countLocal,
      );
      expect(page.total).toBe(4);
      expect(page.items.map((item) => item.id)).toEqual([
        'builtin-inbox-id',
        encodePlatformAgentListId('p1'),
        'agt_1',
        'agt_2',
      ]);
      expect(countLocal).toHaveBeenCalledWith(
        expect.objectContaining({ excludeAgentIds: expect.arrayContaining(['builtin-inbox-id']) }),
      );
    });

    it('filters platform items by keyword and passes the keyword down to the local loader', async () => {
      const { service } = makeService({
        effective: [
          effectiveAgent('p1', 'optional', 'Research Bot'),
          effectiveAgent('p2', 'optional', 'Weather Bot'),
        ],
      });
      const loadLocal = vi.fn(localLoader([localItem('agt_1', 'Research Local')]));
      const result = await service.mergeAvailableAgents(
        'u',
        { keyword: 'research', limit: 10, offset: 0 },
        loadLocal,
        unusedLegacyLoader,
      );
      expect(result.map((r) => r.id)).toEqual([encodePlatformAgentListId('p1'), 'agt_1']);
      expect(loadLocal).toHaveBeenCalledWith(
        expect.objectContaining({ keyword: 'research', limit: 9, offset: 0 }),
      );
    });

    it('searches the managed inbox by its Published title, never the legacy title', async () => {
      const { service } = makeService({
        effective: [
          effectiveAgent(
            'platform-inbox',
            'mandatory',
            'Published Assistant',
            null,
            'default-inbox',
          ),
        ],
      });

      const byPublished = await service.mergeAvailableAgents(
        'u',
        { keyword: 'published', limit: 10, offset: 0 },
        localLoader([]),
        unusedLegacyLoader,
      );
      const byLegacy = await service.mergeAvailableAgents(
        'u',
        { keyword: 'legacy inbox', limit: 10, offset: 0 },
        localLoader([]),
        unusedLegacyLoader,
      );
      expect(byPublished.map(({ id }) => id)).toEqual(['builtin-inbox-id']);
      expect(byPublished[0].title).toBe('Published Assistant');
      expect(byLegacy).toEqual([]);
    });

    it('excludes already-materialized local rows via the loader exclusion set (dedup)', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'optional')],
        materialized: ['agt_materialized'],
      });
      const result = await service.mergeAvailableAgents(
        'u',
        { limit: 10, offset: 0 },
        localLoader([localItem('agt_materialized', 'Dup'), localItem('agt_keep', 'Keep')]),
        unusedLegacyLoader,
      );
      expect(result.map((r) => r.id)).toEqual([
        'builtin-inbox-id',
        encodePlatformAgentListId('p1'),
        'agt_keep',
      ]);
    });
  });

  describe('mergeSidebarList / mergeSearchResults', () => {
    const sidebarLocal = (id: string): SidebarAgentItem => ({
      id,
      pinned: false,
      title: id,
      type: 'agent',
      updatedAt: new Date('2024-01-01T00:00:00Z'),
    });

    it('prepends platform items to ungrouped and strips materialized rows from every bucket', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'mandatory')],
        materialized: ['agt_dup'],
      });
      const base = {
        groups: [
          { id: 'g', items: [sidebarLocal('agt_dup'), sidebarLocal('agt_g')], name: 'G', sort: 0 },
        ],
        pinned: [sidebarLocal('agt_dup')],
        privateGroups: [],
        privateUngrouped: [sidebarLocal('agt_dup')],
        ungrouped: [sidebarLocal('agt_dup'), sidebarLocal('agt_u')],
      };
      const merged = await service.mergeSidebarList('u', base);

      expect(merged.ungrouped.map((i) => i.id)).toEqual([
        'builtin-inbox-id',
        encodePlatformAgentListId('p1'),
        'agt_u',
      ]);
      expect(merged.ungrouped[1].platform).toEqual({
        distribution: 'mandatory',
        managed: true,
        source: 'platform',
      });
      expect(merged.pinned).toEqual([]);
      expect(merged.privateUngrouped).toEqual([]);
      expect(merged.groups[0].items.map((i) => i.id)).toEqual(['agt_g']);
    });

    it('merges keyword-matched platform items into search results', async () => {
      const { service } = makeService({
        effective: [
          effectiveAgent('p1', 'optional', 'Research Bot'),
          effectiveAgent('p2', 'optional', 'Weather Bot'),
        ],
      });
      const merged = await service.mergeSearchResults('u', [sidebarLocal('agt_x')], 'research');
      expect(merged.map((i) => i.id)).toEqual([encodePlatformAgentListId('p1'), 'agt_x']);
    });
  });

  // REWORK-1 / hard-delete scale race: a materialized local row whose platform Agent is now
  // hidden, revoked, OR hard-deleted (tombstoned so it is NOT in the visible effective list)
  // must still be stripped everywhere — never leak back into the ordinary local list, where it
  // would also become runnable via the ordinary runtime as an "editable local" clone.
  describe('hidden / revoked / post-delete tombstoned materializations (REWORK-1)', () => {
    const sidebarLocal = (id: string): SidebarAgentItem => ({
      id,
      pinned: false,
      title: id,
      type: 'agent',
      updatedAt: new Date('2024-01-01T00:00:00Z'),
    });

    it('reads the materialized-id set even when the visible entry list is empty', async () => {
      const { service, getEffectiveList, listMaterializedAgentIds } = makeService({
        effective: [],
        materialized: ['agt_hidden'],
      });
      // Both the resolver and the owner-scoped materialized-id read must run under the managed flag.
      const picker = await service.mergeAvailableAgents(
        'u',
        { limit: 10, offset: 0 },
        localLoader([localItem('agt_hidden', 'Hidden'), localItem('agt_keep', 'Keep')]),
        unusedLegacyLoader,
      );
      expect(picker.map((r) => r.id)).toEqual(['builtin-inbox-id', 'agt_keep']);
      expect(getEffectiveList).toHaveBeenCalledTimes(1);
      expect(listMaterializedAgentIds).toHaveBeenCalledTimes(1);
    });

    it('strips the hidden materialized row from the sidebar even with no visible platform items', async () => {
      const { service } = makeService({ effective: [], materialized: ['agt_hidden'] });
      const base = {
        groups: [],
        pinned: [sidebarLocal('agt_hidden')],
        privateGroups: [],
        privateUngrouped: [],
        ungrouped: [sidebarLocal('agt_hidden'), sidebarLocal('agt_u')],
      };
      const merged = await service.mergeSidebarList('u', base);
      expect(merged.pinned).toEqual([]);
      expect(merged.ungrouped.map((i) => i.id)).toEqual(['builtin-inbox-id', 'agt_u']);
    });

    it('strips the hidden materialized row from search even with no visible platform items', async () => {
      const { service } = makeService({ effective: [], materialized: ['agt_hidden'] });
      const merged = await service.mergeSearchResults(
        'u',
        [sidebarLocal('agt_hidden'), sidebarLocal('agt_x')],
        'anything',
      );
      expect(merged.map((i) => i.id)).toEqual(['agt_x']);
    });

    it('post-delete materialization remains managed/tombstoned — excluded from picker/sidebar/search', async () => {
      // After hard-delete, listMaterializedAgentIds still returns the local clone id (tombstone).
      // Effective list is empty (platform identity gone) — clone must stay excluded everywhere.
      const { service, listMaterializedAgentIds } = makeService({
        effective: [],
        materialized: ['agt_post_delete_clone'],
      });
      const local = localItem('agt_post_delete_clone', 'Surviving clone');
      const picker = await service.mergeAvailableAgents(
        'u',
        { limit: 10, offset: 0 },
        localLoader([local, localItem('agt_keep', 'Keep')]),
        unusedLegacyLoader,
      );
      expect(picker.map((r) => r.id)).toEqual(['builtin-inbox-id', 'agt_keep']);
      expect(listMaterializedAgentIds).toHaveBeenCalled();

      const sidebar = await service.mergeSidebarList('u', {
        groups: [],
        pinned: [sidebarLocal('agt_post_delete_clone')],
        privateGroups: [],
        privateUngrouped: [],
        ungrouped: [sidebarLocal('agt_post_delete_clone'), sidebarLocal('agt_u')],
      });
      expect(sidebar.pinned).toEqual([]);
      expect(sidebar.ungrouped.map((i) => i.id)).toEqual(['builtin-inbox-id', 'agt_u']);

      const search = await service.mergeSearchResults(
        'u',
        [sidebarLocal('agt_post_delete_clone'), sidebarLocal('agt_x')],
        'clone',
      );
      expect(search.map((i) => i.id)).toEqual(['agt_x']);
    });
  });

  describe('takeover (published managed+enforced agents)', () => {
    const sidebarLocal = (id: string): SidebarAgentItem => ({
      id,
      pinned: false,
      title: id,
      type: 'agent',
      updatedAt: new Date('2024-01-01T00:00:00Z'),
    });

    it('sidebar returns only inbox + platform; groups/pinned/private empty; no user ids', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'mandatory')],
        isTakeoverActive: true,
        materialized: ['agt_dup'],
      });
      const base = {
        groups: [
          { id: 'g', items: [sidebarLocal('agt_dup'), sidebarLocal('agt_g')], name: 'G', sort: 0 },
        ],
        pinned: [sidebarLocal('agt_dup')],
        privateGroups: [{ id: 'pg', items: [sidebarLocal('agt_priv')], name: 'P', sort: 0 }],
        privateUngrouped: [sidebarLocal('agt_dup')],
        ungrouped: [sidebarLocal('agt_dup'), sidebarLocal('agt_u')],
      };
      const merged = await service.mergeSidebarList('u', base);

      expect(merged.ungrouped.map((i) => i.id)).toEqual([
        'builtin-inbox-id',
        encodePlatformAgentListId('p1'),
      ]);
      expect(merged.groups).toEqual([]);
      expect(merged.pinned).toEqual([]);
      expect(merged.privateGroups).toEqual([]);
      expect(merged.privateUngrouped).toEqual([]);
    });

    it('page total matches the takeover population from one projection', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'optional'), effectiveAgent('p2', 'optional')],
        isTakeoverActive: true,
      });
      const loadLocal = vi.fn(localLoader([localItem('agt_keep', 'Keep')]));
      const page = await service.mergeAvailableAgentsPage(
        'u',
        { limit: 10, offset: 0 },
        loadLocal,
        unusedLegacyLoader,
        async () => 99,
      );
      expect(loadLocal).not.toHaveBeenCalled();
      expect(page.total).toBe(3);
      expect(page.items.map((item) => item.id)).toEqual([
        'builtin-inbox-id',
        encodePlatformAgentListId('p1'),
        encodePlatformAgentListId('p2'),
      ]);
    });

    it('picker does not call loadLocal and returns no local ids', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'optional')],
        isTakeoverActive: true,
      });
      const loadLocal = vi.fn(localLoader([localItem('agt_keep', 'Keep')]));
      const result = await service.mergeAvailableAgents(
        'u',
        { limit: 10, offset: 0 },
        loadLocal,
        unusedLegacyLoader,
      );

      expect(loadLocal).not.toHaveBeenCalled();
      expect(result.map((r) => r.id)).toEqual([
        'builtin-inbox-id',
        encodePlatformAgentListId('p1'),
      ]);
    });

    it('search returns no user-owned ids', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'optional', 'Research Bot')],
        isTakeoverActive: true,
      });
      const merged = await service.mergeSearchResults('u', [sidebarLocal('agt_x')], 'research');
      expect(merged.map((i) => i.id)).toEqual([encodePlatformAgentListId('p1')]);
    });

    it('empty assignment set yields inbox only (replace, not a second bug)', async () => {
      const { service } = makeService({ effective: [], isTakeoverActive: true });
      const merged = await service.mergeSidebarList('u', {
        groups: [],
        pinned: [],
        privateGroups: [],
        privateUngrouped: [],
        ungrouped: [sidebarLocal('agt_u')],
      });
      expect(merged.ungrouped.map((i) => i.id)).toEqual(['builtin-inbox-id']);
    });
  });
});
