import { INBOX_SESSION_ID } from '@lobechat/const';
import {
  encodePlatformAgentListId,
  PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
  type PlatformAgentAssignmentMode,
  type PlatformAgentConfigMeta,
  type PlatformAgentUserListMeta,
  type SidebarAgentItem,
  type SidebarAgentListResponse,
} from '@lobechat/types';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type { PlatformManagedResourcePolicyModel } from '@/database/models/platform';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';
import { AgentService } from '@/server/services/agent';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformAgentEffectiveResolver } from './effectiveResolver';
import { isPlatformAgentTakeoverActive } from './enforcement';

/**
 * A platform Agent as it appears in an ordinary user's unified Agent list — the user-safe subset
 * of the effective projection. No admin metadata, no version pointer, no checksum.
 */
export interface PlatformAgentUserListEntry {
  avatar: string | null;
  backgroundColor: string | null;
  description: string | null;
  distribution: PlatformAgentAssignmentMode;
  /** Encoded, collision-proof list-item identity (request-entry hint only). */
  id: string;
  platformAgentId: string;
  title: string;
}

/** Unified picker item — the ordinary agent shape plus optional platform metadata. */
export interface UnifiedAvailableAgentItem {
  avatar: string | null;
  backgroundColor: string | null;
  description: string | null;
  heteroType?: string;
  id: string;
  platform?: PlatformAgentUserListMeta;
  title: string | null;
}

/** A visibility-resolved projection: what the user may see, plus the local rows to hide. */
interface VisibleProjection {
  builtinInbox: UnifiedAvailableAgentItem;
  entries: PlatformAgentUserListEntry[];
  /** Local Agent ids already materialized from a platform Agent — hidden from the local list. */
  materializedAgentIds: Set<string>;
}

interface BuiltinInboxListSource {
  avatar?: string | null;
  backgroundColor?: string | null;
  description?: string | null;
  id: string;
  platform?: PlatformAgentConfigMeta;
  title?: string | null;
}

interface PlatformAgentUserListServiceOptions {
  flags?: EnterpriseFeatureFlags;
  /**
   * Override for tests. Production default is {@link isPlatformAgentTakeoverActive}
   * (published + managed + enforced). When true, lists contain ONLY the builtin
   * inbox and assigned platform agents — local user rows are not merged.
   */
  isTakeoverActive?: () => Promise<boolean>;
  loadBuiltinInbox?: (
    userId: string,
    workspaceId?: string,
  ) => Promise<BuiltinInboxListSource | null>;
  policyModel?: Pick<PlatformManagedResourcePolicyModel, 'getSnapshot'>;
  repository?: PlatformAgentCatalogRepository;
  resolver?: Pick<PlatformAgentEffectiveResolver, 'getEffectiveList'>;
}

const SIDEBAR_PLATFORM_UPDATED_AT = new Date(0);

const matchesKeyword = (entry: PlatformAgentUserListEntry, keyword: string): boolean => {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    entry.title.toLowerCase().includes(needle) ||
    (entry.description ?? '').toLowerCase().includes(needle)
  );
};

const toMeta = (entry: PlatformAgentUserListEntry): PlatformAgentUserListMeta => ({
  distribution: entry.distribution,
  managed: true,
  source: 'platform',
});

/**
 * Enterprise adapter that merges effective platform Agents into an ordinary user's Agent lists
 * (M10 PR-049 · A). It is the ONLY place the platform catalog touches the unified list — the
 * open-source `HomeRepository` / `AgentModel` stay platform-agnostic so the database layer never
 * depends on enterprise code.
 *
 * When `ENABLE_PLATFORM_MANAGED_AGENTS` is off it short-circuits with ZERO catalog queries and
 * returns the legacy result untouched. List reads NEVER materialize a local Agent row.
 */
export class PlatformAgentUserListService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly workspaceId?: string,
    private readonly options: PlatformAgentUserListServiceOptions = {},
  ) {}

  private flags = (): EnterpriseFeatureFlags =>
    this.options.flags ?? parseEnterpriseFeatureFlags(process.env);

  private isTakeoverActive = (): Promise<boolean> =>
    this.options.isTakeoverActive?.() ?? isPlatformAgentTakeoverActive(this.db, this.flags());

  private repository = (): PlatformAgentCatalogRepository =>
    this.options.repository ?? new PlatformAgentCatalogRepository(this.db);

  private resolver = (): Pick<PlatformAgentEffectiveResolver, 'getEffectiveList'> =>
    this.options.resolver ??
    new PlatformAgentEffectiveResolver(this.db, {
      flags: this.options.flags,
      policyModel: this.options.policyModel,
      repository: this.options.repository,
    });

  private loadBuiltinInbox = async (userId: string): Promise<UnifiedAvailableAgentItem> => {
    const loader =
      this.options.loadBuiltinInbox ??
      (async (ownerId: string, workspaceId?: string): Promise<BuiltinInboxListSource | null> =>
        (await new AgentService(this.db, ownerId, workspaceId).getBuiltinAgent(
          INBOX_SESSION_ID,
        )) as BuiltinInboxListSource | null);
    const inbox = await loader(userId, this.workspaceId);
    if (!inbox) throw new Error('Builtin inbox is unavailable');
    return {
      avatar: inbox.avatar ?? null,
      backgroundColor: inbox.backgroundColor ?? null,
      description: inbox.description ?? null,
      id: inbox.id,
      platform:
        inbox.platform?.managed && inbox.platform.distribution
          ? {
              distribution: inbox.platform.distribution,
              managed: true,
              source: 'platform',
            }
          : undefined,
      title: inbox.title ?? null,
    };
  };

  /**
   * Resolve the owner-scoped visible platform Agents (already hidden-filtered and ordered by the
   * resolver) plus the set of local rows to de-duplicate.
   *
   * Flag on → ALWAYS read the owner-scoped materialized-id set, even when the visible entries are
   * empty. A materialized local row for an Agent the user has since hidden, or whose assignment was
   * revoked, is NOT in `getEffectiveList` — but it must still be stripped from the ordinary local
   * list (and never routed through ordinary runtime). Short-circuiting on an empty visible set would
   * let that row leak back in (REWORK-1).
   */
  private getVisibleProjection = async (userId: string): Promise<VisibleProjection> => {
    const builtinInboxPromise = this.loadBuiltinInbox(userId);
    const [builtinInbox, { agents }, materializedAgentIds] = await Promise.all([
      builtinInboxPromise,
      this.resolver().getEffectiveList(userId),
      this.repository().listMaterializedAgentIds(userId),
    ]);
    // The stable default-inbox is rendered through the existing builtin inbox row/selector/URL.
    // Do not add a second encoded platform identity to ordinary lists.
    const entries = agents
      .filter((agent) => agent.systemKey !== PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY)
      .map((agent): PlatformAgentUserListEntry => ({
        avatar: agent.config.avatar,
        backgroundColor: agent.config.backgroundColor,
        description: agent.config.description,
        distribution: agent.distribution,
        id: encodePlatformAgentListId(agent.platformAgentId),
        platformAgentId: agent.platformAgentId,
        title: agent.config.displayName,
      }));
    return { builtinInbox, entries, materializedAgentIds };
  };

  /**
   * Merge platform items into the paginated picker list. Deterministic total order — platform
   * items first (resolver order), then local agents — with a single, non-overlapping window applied
   * across the concatenation so `limit`/`offset` never drop or duplicate an item. Local rows are
   * loaded via the injected callback so their exclusion + offset stay in-SQL (exact pagination).
   */
  mergeAvailableAgents = async (
    userId: string,
    params: { keyword?: string; limit: number; offset: number },
    loadLocal: (localParams: {
      excludeAgentIds: string[];
      keyword?: string;
      limit: number;
      offset: number;
    }) => Promise<UnifiedAvailableAgentItem[]>,
    loadLegacy: () => Promise<UnifiedAvailableAgentItem[]>,
  ): Promise<UnifiedAvailableAgentItem[]> =>
    (await this.mergeAvailableAgentsPage(userId, params, loadLocal, loadLegacy, async () => 0))
      .items;

  /**
   * Same filtered population as {@link mergeAvailableAgents}, with a `total` that
   * matches that population so pagination `hasMore` cannot drift.
   */
  mergeAvailableAgentsPage = async (
    userId: string,
    params: { keyword?: string; limit: number; offset: number },
    loadLocal: (localParams: {
      excludeAgentIds: string[];
      keyword?: string;
      limit: number;
      offset: number;
    }) => Promise<UnifiedAvailableAgentItem[]>,
    loadLegacy: () => Promise<UnifiedAvailableAgentItem[]>,
    countLegacy: () => Promise<number>,
    countLocal?: (localParams: { excludeAgentIds: string[]; keyword?: string }) => Promise<number>,
  ): Promise<{ items: UnifiedAvailableAgentItem[]; total: number }> => {
    if (!this.flags().ENABLE_PLATFORM_MANAGED_AGENTS) {
      const [items, total] = await Promise.all([loadLegacy(), countLegacy()]);
      return { items, total };
    }

    const { builtinInbox, entries, materializedAgentIds } = await this.getVisibleProjection(userId);
    const builtinMatches = params.keyword
      ? matchesUnifiedKeyword(builtinInbox, params.keyword)
      : true;
    const platformEntries = params.keyword
      ? entries.filter((entry) => matchesKeyword(entry, params.keyword!))
      : entries;
    const platform = [
      ...(builtinMatches ? [builtinInbox] : []),
      ...platformEntries.map(this.toPickerItem),
    ];

    const platformWindow = platform.slice(params.offset, params.offset + params.limit);
    if (await this.isTakeoverActive()) {
      return { items: platformWindow, total: platform.length };
    }

    const excludeAgentIds = [...new Set([...materializedAgentIds, builtinInbox.id])];
    const remaining = params.limit - platformWindow.length;
    const localOffset = Math.max(0, params.offset - platform.length);
    const [local, localTotal] = await Promise.all([
      remaining > 0
        ? loadLocal({
            excludeAgentIds,
            keyword: params.keyword,
            limit: remaining,
            offset: localOffset,
          })
        : Promise.resolve([]),
      countLocal ? countLocal({ excludeAgentIds, keyword: params.keyword }) : Promise.resolve(0),
    ]);

    return { items: [...platformWindow, ...local], total: platform.length + localTotal };
  };

  /**
   * Merge platform items into the home sidebar list. Materialized local rows are stripped from
   * every bucket (they are represented by their platform item), and platform items are prepended to
   * the public ungrouped bucket in resolver order so managed/mandatory Agents surface first.
   */
  mergeSidebarList = async (
    userId: string,
    base: SidebarAgentListResponse,
  ): Promise<SidebarAgentListResponse> => {
    if (!this.flags().ENABLE_PLATFORM_MANAGED_AGENTS) return base;

    const { builtinInbox, entries, materializedAgentIds } = await this.getVisibleProjection(userId);
    if (await this.isTakeoverActive()) {
      return {
        groups: [],
        pinned: [],
        privateGroups: [],
        privateUngrouped: [],
        ungrouped: [this.builtinToSidebarItem(builtinInbox), ...entries.map(this.toSidebarItem)],
      };
    }

    const excludedIds = new Set([...materializedAgentIds, builtinInbox.id]);

    const strip = (items: SidebarAgentItem[]): SidebarAgentItem[] =>
      items.filter((item) => !excludedIds.has(item.id));

    return {
      groups: base.groups.map((group) => ({ ...group, items: strip(group.items) })),
      pinned: strip(base.pinned),
      privateGroups: base.privateGroups.map((group) => ({ ...group, items: strip(group.items) })),
      privateUngrouped: strip(base.privateUngrouped),
      ungrouped: [
        this.builtinToSidebarItem(builtinInbox),
        ...entries.map(this.toSidebarItem),
        ...strip(base.ungrouped),
      ],
    };
  };

  /** Merge keyword-matched platform items into the home search results (platform items first). */
  mergeSearchResults = async (
    userId: string,
    base: SidebarAgentItem[],
    keyword: string,
  ): Promise<SidebarAgentItem[]> => {
    if (!this.flags().ENABLE_PLATFORM_MANAGED_AGENTS) return base;

    const { builtinInbox, entries, materializedAgentIds } = await this.getVisibleProjection(userId);
    const matched = entries.filter((entry) => matchesKeyword(entry, keyword));
    const platformHits = [
      ...(matchesUnifiedKeyword(builtinInbox, keyword)
        ? [this.builtinToSidebarItem(builtinInbox)]
        : []),
      ...matched.map(this.toSidebarItem),
    ];
    if (await this.isTakeoverActive()) return platformHits;

    const excludedIds = new Set([...materializedAgentIds, builtinInbox.id]);
    const local = base.filter((item) => !excludedIds.has(item.id));
    return [...platformHits, ...local];
  };

  private toPickerItem = (entry: PlatformAgentUserListEntry): UnifiedAvailableAgentItem => ({
    avatar: entry.avatar,
    backgroundColor: entry.backgroundColor,
    description: entry.description,
    id: entry.id,
    platform: toMeta(entry),
    title: entry.title,
  });

  private toSidebarItem = (entry: PlatformAgentUserListEntry): SidebarAgentItem => ({
    avatar: entry.avatar,
    backgroundColor: entry.backgroundColor,
    description: entry.description,
    id: entry.id,
    pinned: false,
    platform: toMeta(entry),
    sessionId: null,
    title: entry.title,
    type: 'agent',
    updatedAt: SIDEBAR_PLATFORM_UPDATED_AT,
    visibility: 'public',
  });

  private builtinToSidebarItem = (entry: UnifiedAvailableAgentItem): SidebarAgentItem => ({
    avatar: entry.avatar,
    backgroundColor: entry.backgroundColor,
    description: entry.description,
    id: entry.id,
    pinned: false,
    platform: entry.platform,
    sessionId: null,
    title: entry.title,
    type: 'agent',
    updatedAt: SIDEBAR_PLATFORM_UPDATED_AT,
    visibility: 'public',
  });
}

const matchesUnifiedKeyword = (entry: UnifiedAvailableAgentItem, keyword: string): boolean => {
  const needle = keyword.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    (entry.title ?? '').toLowerCase().includes(needle) ||
    (entry.description ?? '').toLowerCase().includes(needle)
  );
};
