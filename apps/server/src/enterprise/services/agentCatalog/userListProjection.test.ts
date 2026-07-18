import type { PlatformAgentAssignmentMode, SidebarAgentItem } from '@lobechat/types';
import { encodePlatformAgentListId } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ENTERPRISE_FEATURE_FLAGS } from '@/const/platform/featureFlags';
import type { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import type { PlatformAgentEffectiveResolver } from './effectiveResolver';
import { PlatformAgentUserListService, type UnifiedAvailableAgentItem } from './userListProjection';

const flagsOn = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: true };
const flagsOff = { ...DEFAULT_ENTERPRISE_FEATURE_FLAGS, ENABLE_PLATFORM_MANAGED_AGENTS: false };

const effectiveAgent = (
  platformAgentId: string,
  distribution: PlatformAgentAssignmentMode,
  displayName = platformAgentId,
  description: string | null = null,
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
  systemKey: null,
  version: '1.0.0',
  versionId: `${platformAgentId}-v1`,
});

const makeService = (params: {
  effective?: ReturnType<typeof effectiveAgent>[];
  flags?: typeof flagsOn;
  materialized?: string[];
}) => {
  const getEffectiveList = vi.fn(async () => ({
    agents: params.effective ?? [],
    revision: 'r',
  }));
  const listMaterializedAgentIds = vi.fn(async () => new Set(params.materialized ?? []));
  const service = new PlatformAgentUserListService({} as LobeChatDatabase, {
    flags: params.flags ?? flagsOn,
    repository: { listMaterializedAgentIds } as unknown as PlatformAgentCatalogRepository,
    resolver: { getEffectiveList } as unknown as Pick<
      PlatformAgentEffectiveResolver,
      'getEffectiveList'
    >,
  });
  return { getEffectiveList, listMaterializedAgentIds, service };
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

describe('PlatformAgentUserListService', () => {
  describe('flag off', () => {
    it('returns the legacy local-only result with zero catalog access', async () => {
      const { service, getEffectiveList, listMaterializedAgentIds } = makeService({
        flags: flagsOff,
      });
      const loadLocal = vi.fn(localLoader([localItem('agt_1', 'Local One')]));

      const result = await service.mergeAvailableAgents(
        'user-a',
        { limit: 10, offset: 0 },
        loadLocal,
      );

      expect(result).toEqual([localItem('agt_1', 'Local One')]);
      expect(getEffectiveList).not.toHaveBeenCalled();
      expect(listMaterializedAgentIds).not.toHaveBeenCalled();
      // Local loader still runs with an empty exclusion set — no platform interference.
      expect(loadLocal).toHaveBeenCalledWith({
        excludeAgentIds: [],
        keyword: undefined,
        limit: 10,
        offset: 0,
      });
    });

    it('sidebar merge returns the base unchanged and never queries the catalog', async () => {
      const { service, getEffectiveList } = makeService({ flags: flagsOff });
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
      expect(getEffectiveList).not.toHaveBeenCalled();
    });
  });

  describe('mergeAvailableAgents (picker)', () => {
    it('places platform items first, then local, in a single non-overlapping window', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'mandatory'), effectiveAgent('p2', 'default')],
      });
      const result = await service.mergeAvailableAgents(
        'user-a',
        { limit: 10, offset: 0 },
        localLoader([localItem('agt_1', 'Local One'), localItem('agt_2', 'Local Two')]),
      );
      expect(result.map((r) => r.id)).toEqual([
        encodePlatformAgentListId('p1'),
        encodePlatformAgentListId('p2'),
        'agt_1',
        'agt_2',
      ]);
      expect(result[0].platform).toEqual({
        distribution: 'mandatory',
        managed: true,
        platformAgentId: 'p1',
        source: 'platform',
      });
    });

    it('paginates across the boundary without dropping or duplicating items', async () => {
      const { service } = makeService({
        effective: [effectiveAgent('p1', 'mandatory'), effectiveAgent('p2', 'optional')],
      });
      const local = [localItem('agt_1', 'L1'), localItem('agt_2', 'L2'), localItem('agt_3', 'L3')];

      // Page size 2 across [p1, p2, agt_1, agt_2, agt_3].
      const page1 = await service.mergeAvailableAgents(
        'u',
        { limit: 2, offset: 0 },
        localLoader(local),
      );
      const page2 = await service.mergeAvailableAgents(
        'u',
        { limit: 2, offset: 2 },
        localLoader(local),
      );
      const page3 = await service.mergeAvailableAgents(
        'u',
        { limit: 2, offset: 4 },
        localLoader(local),
      );

      expect(page1.map((r) => r.id)).toEqual([
        encodePlatformAgentListId('p1'),
        encodePlatformAgentListId('p2'),
      ]);
      expect(page2.map((r) => r.id)).toEqual(['agt_1', 'agt_2']);
      expect(page3.map((r) => r.id)).toEqual(['agt_3']);
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
      );
      expect(result.map((r) => r.id)).toEqual([encodePlatformAgentListId('p1'), 'agt_1']);
      expect(loadLocal).toHaveBeenCalledWith(
        expect.objectContaining({ keyword: 'research', limit: 9, offset: 0 }),
      );
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
      );
      expect(result.map((r) => r.id)).toEqual([encodePlatformAgentListId('p1'), 'agt_keep']);
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

      expect(merged.ungrouped.map((i) => i.id)).toEqual([encodePlatformAgentListId('p1'), 'agt_u']);
      expect(merged.ungrouped[0].platform?.platformAgentId).toBe('p1');
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

  // REWORK-1: a materialized local row whose platform Agent is now hidden/revoked (so it is NOT in
  // the visible effective list) must still be stripped everywhere — never leak back into the
  // ordinary local list, where it would also become runnable via the ordinary runtime.
  describe('hidden / revoked materialized rows (REWORK-1)', () => {
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
      );
      expect(picker.map((r) => r.id)).toEqual(['agt_keep']);
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
      expect(merged.ungrouped.map((i) => i.id)).toEqual(['agt_u']);
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
  });
});
