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
 * Hard cap on cursor-followed dependency-catalog preflight drains (provider revisions only).
 * Provider/connector *pickers* use server-side paginated search (one page per query) instead of
 * silent multi-page drains.
 */
export const ADMIN_AGENT_DEP_COLLECTION_PAGE_LIMIT = 20;

/** One server page of catalog options with an explicit truncation signal. */
export interface CatalogSearchPage<T> {
  items: T[];
  /** True when the server returned a nextCursor — more matching rows exist beyond this page. */
  truncated: boolean;
}

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

/**
 * Server-side published-provider search for the model dependency picker.
 * One page per query (limit 100) — never silently drains past a page ceiling.
 * Pass a debounced `query` so typing re-keys SWR without local catalog filtering alone.
 */
export const useAdminPublishedProviders = (
  enabled: boolean,
  query = '',
  service: PublishedProviderService = adminAiCatalogService,
) =>
  useClientDataSWR<CatalogSearchPage<PublishedProviderSummary>>(
    enabled ? [DEP_PROVIDERS_KEY, query] : null,
    async () => {
      const page = await service.listProviders({
        limit: 100,
        query: query.trim() || undefined,
        status: 'published',
      });
      const items: PublishedProviderSummary[] = [];
      for (const provider of page.items) {
        if (provider.status !== 'published') continue;
        items.push({
          displayName: provider.displayName,
          id: provider.id,
          providerKey: provider.providerKey,
        });
      }
      return { items, truncated: page.nextCursor !== null };
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

/**
 * Server-side published-connector search for the connector dependency picker.
 * One page per query — never silently drains past a page ceiling.
 */
export const useAdminPublishedConnectors = (
  enabled: boolean,
  query = '',
  service: PublishedConnectorService = adminConnectorsService,
) =>
  useClientDataSWR<CatalogSearchPage<PublishedConnectorSummary>>(
    enabled ? [DEP_CONNECTORS_KEY, query] : null,
    async () => {
      const page = await service.list({
        limit: 100,
        query: query.trim() || undefined,
        status: 'published',
      });
      const items: PublishedConnectorSummary[] = [];
      for (const connector of page.items) {
        if (connector.status !== 'published') continue;
        items.push({
          displayName: connector.displayName,
          id: connector.id,
          key: connector.key,
        });
      }
      return { items, truncated: page.nextCursor !== null };
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
