'use client';

import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';
import { platformSkillsService } from '@/enterprise/client/services/platformSkills';
import { useClientDataSWR } from '@/libs/swr';

import {
  type ProviderRevisionRef,
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

const DEP_PROVIDERS_KEY = 'enterprise.admin.agents.dep.providers';
const DEP_PROVIDER_SOURCE_KEY = 'enterprise.admin.agents.dep.providerSource';
const DEP_SKILLS_KEY = 'enterprise.admin.agents.dep.skills';

export const useAdminPublishedProviders = (
  enabled: boolean,
  service: PublishedProviderService = adminAiCatalogService,
) =>
  useClientDataSWR<PublishedProviderSummary[]>(
    enabled ? [DEP_PROVIDERS_KEY] : null,
    async () => {
      const items: PublishedProviderSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.listProviders({ cursor, limit: 100, status: 'published' });
        for (const provider of page.items) {
          if (provider.status !== 'published') continue;
          items.push({
            displayName: provider.displayName,
            id: provider.id,
            providerKey: provider.providerKey,
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
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
      let beforeRevision: number | undefined;
      do {
        const page = await service.listProviderRevisions({ beforeRevision, id, limit: 100 });
        revisions.push(...page.items);
        if (page.items.some((item) => item.revision === targetRevision)) break;
        beforeRevision = page.nextCursor ?? undefined;
      } while (beforeRevision);

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
