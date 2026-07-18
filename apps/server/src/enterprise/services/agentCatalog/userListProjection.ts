import {
  encodePlatformAgentListId,
  type PlatformAgentAssignmentMode,
  type PlatformAgentUserListMeta,
  type SidebarAgentItem,
  type SidebarAgentListResponse,
} from '@lobechat/types';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type { PlatformManagedResourcePolicyModel } from '@/database/models/platform';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformAgentEffectiveResolver } from './effectiveResolver';

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
  entries: PlatformAgentUserListEntry[];
  /** Local Agent ids already materialized from a platform Agent — hidden from the local list. */
  materializedAgentIds: Set<string>;
}

interface PlatformAgentUserListServiceOptions {
  flags?: EnterpriseFeatureFlags;
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
  platformAgentId: entry.platformAgentId,
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
    private readonly options: PlatformAgentUserListServiceOptions = {},
  ) {}

  private flags = (): EnterpriseFeatureFlags =>
    this.options.flags ?? parseEnterpriseFeatureFlags(process.env);

  private repository = (): PlatformAgentCatalogRepository =>
    this.options.repository ?? new PlatformAgentCatalogRepository(this.db);

  private resolver = (): Pick<PlatformAgentEffectiveResolver, 'getEffectiveList'> =>
    this.options.resolver ??
    new PlatformAgentEffectiveResolver(this.db, {
      flags: this.options.flags,
      policyModel: this.options.policyModel,
      repository: this.options.repository,
    });

  /**
   * Resolve the owner-scoped visible platform Agents (already hidden-filtered and ordered by the
   * resolver) plus the set of local rows to de-duplicate. Flag off → empty, no catalog access.
   */
  private getVisibleProjection = async (userId: string): Promise<VisibleProjection> => {
    if (!this.flags().ENABLE_PLATFORM_MANAGED_AGENTS) {
      return { entries: [], materializedAgentIds: new Set() };
    }
    const { agents } = await this.resolver().getEffectiveList(userId);
    if (agents.length === 0) return { entries: [], materializedAgentIds: new Set() };

    const materializedAgentIds = await this.repository().listMaterializedAgentIds(userId);
    const entries = agents.map((agent): PlatformAgentUserListEntry => ({
      avatar: agent.config.avatar,
      backgroundColor: agent.config.backgroundColor,
      description: agent.config.description,
      distribution: agent.distribution,
      id: encodePlatformAgentListId(agent.platformAgentId),
      platformAgentId: agent.platformAgentId,
      title: agent.config.displayName,
    }));
    return { entries, materializedAgentIds };
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
  ): Promise<UnifiedAvailableAgentItem[]> => {
    const { entries, materializedAgentIds } = await this.getVisibleProjection(userId);
    const platform = params.keyword
      ? entries.filter((entry) => matchesKeyword(entry, params.keyword!))
      : entries;

    const platformWindow = platform.slice(params.offset, params.offset + params.limit);
    const remaining = params.limit - platformWindow.length;
    const local =
      remaining > 0
        ? await loadLocal({
            excludeAgentIds: [...materializedAgentIds],
            keyword: params.keyword,
            limit: remaining,
            // Once platform items are exhausted, continue into the local list from where the
            // combined window falls (never negative).
            offset: Math.max(0, params.offset - platform.length),
          })
        : [];

    return [...platformWindow.map(this.toPickerItem), ...local];
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
    const { entries, materializedAgentIds } = await this.getVisibleProjection(userId);
    if (entries.length === 0 && materializedAgentIds.size === 0) return base;

    const strip = (items: SidebarAgentItem[]): SidebarAgentItem[] =>
      materializedAgentIds.size === 0
        ? items
        : items.filter((item) => !materializedAgentIds.has(item.id));

    return {
      groups: base.groups.map((group) => ({ ...group, items: strip(group.items) })),
      pinned: strip(base.pinned),
      privateGroups: base.privateGroups.map((group) => ({ ...group, items: strip(group.items) })),
      privateUngrouped: strip(base.privateUngrouped),
      ungrouped: [...entries.map(this.toSidebarItem), ...strip(base.ungrouped)],
    };
  };

  /** Merge keyword-matched platform items into the home search results (platform items first). */
  mergeSearchResults = async (
    userId: string,
    base: SidebarAgentItem[],
    keyword: string,
  ): Promise<SidebarAgentItem[]> => {
    const { entries, materializedAgentIds } = await this.getVisibleProjection(userId);
    const matched = entries.filter((entry) => matchesKeyword(entry, keyword));
    const local =
      materializedAgentIds.size === 0
        ? base
        : base.filter((item) => !materializedAgentIds.has(item.id));
    return [...matched.map(this.toSidebarItem), ...local];
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
}
