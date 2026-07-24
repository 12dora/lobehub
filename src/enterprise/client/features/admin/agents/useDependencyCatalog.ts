'use client';

import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { platformSkillsService } from '@/enterprise/client/services/platformSkills';
import { useClientDataSWR } from '@/libs/swr';

import {
  type ProviderRevisionRef,
  type PublishedConnectorDetail,
  type PublishedConnectorSummary,
  type PublishedProviderSummary,
  type PublishedSkillOption,
  type ResolvedProviderModelSource,
  resolveProviderModelSource,
} from './dependencyCatalog';

/**
 * Data-fetching boundary for authoring the exact dependency snapshot. Every read goes through an
 * existing reviewed service (M07 AI catalog, M08 published skill catalog); components consume
 * these hooks and never call lambda directly. Services are injectable so tests can supply fakes.
 */

export type PublishedProviderService = Pick<
  typeof adminAiCatalogService,
  'getProvider' | 'listProviderRevisions' | 'listProviders'
>;
export type PublishedSkillService = Pick<typeof platformSkillsService, 'getPublishedCatalog'>;
export type PublishedConnectorService = Pick<
  typeof adminConnectorsService,
  'get' | 'getPublishedBatch' | 'list'
>;

const DEP_PROVIDERS_KEY = 'enterprise.admin.agents.dep.providers';
const DEP_PROVIDER_SOURCE_KEY = 'enterprise.admin.agents.dep.providerSource';
const DEP_SKILLS_KEY = 'enterprise.admin.agents.dep.skills';
const DEP_CONNECTORS_KEY = 'enterprise.admin.agents.dep.connectors';
const DEP_CONNECTOR_DETAIL_KEY = 'enterprise.admin.agents.dep.connectorDetail';
const DEP_CONNECTOR_DETAILS_KEY = 'enterprise.admin.agents.dep.connectorDetails';

/**
 * Hard cap on cursor-followed dependency-catalog preflight drains (providers / connectors /
 * provider revisions). 20 pages × 100 items = 2,000 rows — enough for the editor without
 * unbounded memory growth or a stuck cursor cycle.
 */
export const ADMIN_AGENT_DEP_COLLECTION_PAGE_LIMIT = 20;

/** Cursor-safe page walk: stops on cycle or at {@link ADMIN_AGENT_DEP_COLLECTION_PAGE_LIMIT}. */
const collectCursorPages = async <T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> => {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (cursor) {
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
    }
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor && pages < ADMIN_AGENT_DEP_COLLECTION_PAGE_LIMIT);
  return items;
};

const toConnectorDetail = (
  published: NonNullable<Awaited<ReturnType<PublishedConnectorService['get']>>['published']>,
): PublishedConnectorDetail => ({
  connectorId: published.id,
  connectorKey: published.key,
  publishedChecksum: published.publishedChecksum,
  publishedRevision: published.publishedRevision,
  tools: published.tools.map((tool) => ({
    platformPolicy: tool.platformPolicy,
    toolKey: tool.toolKey,
  })),
});

export const useAdminPublishedProviders = (
  enabled: boolean,
  service: PublishedProviderService = adminAiCatalogService,
) =>
  useClientDataSWR<PublishedProviderSummary[]>(
    enabled ? [DEP_PROVIDERS_KEY] : null,
    async () => {
      const pages = await collectCursorPages((cursor) =>
        service.listProviders({ cursor, limit: 100, status: 'published' }),
      );
      const items: PublishedProviderSummary[] = [];
      for (const provider of pages) {
        if (provider.status !== 'published') continue;
        items.push({
          displayName: provider.displayName,
          id: provider.id,
          providerKey: provider.providerKey,
        });
      }
      return items;
    },
    { revalidateOnFocus: false },
  );

/**
 * Resolve the exact provider model source (revision + checksum) for one provider by joining its
 * published detail with its revision history. Pages the history until the published revision's
 * checksum is found; returns `null` (unavailable) rather than fabricating a checksum.
 */
export const useAdminProviderModelSource = (
  providerId: string | undefined,
  service: PublishedProviderService = adminAiCatalogService,
) =>
  useClientDataSWR<ResolvedProviderModelSource | null>(
    providerId ? [DEP_PROVIDER_SOURCE_KEY, providerId] : null,
    async () => {
      const id = providerId!;
      const detail = await service.getProvider({ id });
      if (!detail.published) return null;
      const targetRevision = detail.published.revision;

      const revisions: ProviderRevisionRef[] = [];
      const seenCursors = new Set<number>();
      let beforeRevision: number | undefined;
      let pages = 0;
      do {
        if (beforeRevision !== undefined) {
          if (seenCursors.has(beforeRevision)) break;
          seenCursors.add(beforeRevision);
        }
        const page = await service.listProviderRevisions({ beforeRevision, id, limit: 100 });
        revisions.push(...page.items);
        if (page.items.some((item) => item.revision === targetRevision)) break;
        beforeRevision = page.nextCursor ?? undefined;
        pages += 1;
      } while (beforeRevision !== undefined && pages < ADMIN_AGENT_DEP_COLLECTION_PAGE_LIMIT);

      return resolveProviderModelSource(detail.published, revisions);
    },
    { revalidateOnFocus: false },
  );

export const useAdminPublishedSkills = (
  enabled: boolean,
  service: PublishedSkillService = platformSkillsService,
) =>
  useClientDataSWR<PublishedSkillOption[]>(
    enabled ? [DEP_SKILLS_KEY] : null,
    async () => {
      const catalog = await service.getPublishedCatalog();
      return catalog.skills.map((skill) => ({
        checksum: skill.checksum,
        displayName: skill.displayName,
        distribution: skill.distribution,
        skillKey: skill.skillKey,
        version: skill.version,
      }));
    },
    { revalidateOnFocus: false },
  );

export const useAdminPublishedConnectors = (
  enabled: boolean,
  service: PublishedConnectorService = adminConnectorsService,
) =>
  useClientDataSWR<PublishedConnectorSummary[]>(
    enabled ? [DEP_CONNECTORS_KEY] : null,
    async () => {
      const pages = await collectCursorPages((cursor) =>
        service.list({ cursor, limit: 100, status: 'published' }),
      );
      const items: PublishedConnectorSummary[] = [];
      for (const connector of pages) {
        if (connector.status !== 'published') continue;
        items.push({
          displayName: connector.displayName,
          id: connector.id,
          key: connector.key,
        });
      }
      return items;
    },
    { revalidateOnFocus: false },
  );

/**
 * Resolve one published connector's EXACT ref inputs — id, key, published revision + checksum and
 * its published tools (with platform policy). Returns `null` when the connector has no published
 * revision, so the UI shows "unavailable" rather than fabricating a checksum.
 */
export const useAdminConnectorDetail = (
  connectorId: string | undefined,
  service: PublishedConnectorService = adminConnectorsService,
) =>
  useClientDataSWR<PublishedConnectorDetail | null>(
    connectorId ? [DEP_CONNECTOR_DETAIL_KEY, connectorId] : null,
    async () => {
      const detail = await service.get({ id: connectorId! });
      return detail.published ? toConnectorDetail(detail.published) : null;
    },
    { revalidateOnFocus: false },
  );

/**
 * Fetch the exact published detail for EVERY referenced connector id so existing connector refs can
 * be validated against the current catalog (checksum/revision/tools). Uses ONE bounded batch read
 * (`admin.connectors.getPublishedBatch`, ≤100 ids) — never N per-connector requests. Returns a map
 * keyed by connectorId (`null` when a referenced connector is unpublished/missing); `data` stays
 * `undefined` until settled so callers fail closed while loading.
 */
export const useAdminConnectorDetails = (
  connectorIds: readonly string[],
  service: PublishedConnectorService = adminConnectorsService,
) => {
  const ids = [...new Set(connectorIds)].sort();
  return useClientDataSWR<Record<string, PublishedConnectorDetail | null>>(
    ids.length ? [DEP_CONNECTOR_DETAILS_KEY, ids.join(',')] : null,
    async () => {
      const { items } = await service.getPublishedBatch({ ids });
      const map: Record<string, PublishedConnectorDetail | null> = {};
      for (const item of items) {
        map[item.connectorId] = item.published
          ? {
              connectorId: item.published.connectorId,
              connectorKey: item.published.connectorKey,
              publishedChecksum: item.published.publishedChecksum,
              publishedRevision: item.published.publishedRevision,
              tools: item.published.tools.map((tool) => ({
                platformPolicy: tool.platformPolicy,
                toolKey: tool.toolKey,
              })),
            }
          : null;
      }
      return map;
    },
    { revalidateOnFocus: false },
  );
};
