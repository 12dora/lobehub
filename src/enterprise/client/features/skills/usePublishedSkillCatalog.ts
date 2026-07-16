'use client';

import { mutate } from 'swr';

import { useClientDataSWR } from '@/libs/swr';
import { useToolStore } from '@/store/tool';

import { platformSkillsService } from '../../services/platformSkills';

export const PLATFORM_PUBLISHED_SKILL_CATALOG_KEY = 'platform.skills.getPublishedCatalog';

/**
 * Fetches the exact public catalog used by the server runtime. Callers must
 * keep this disabled outside managed Skill mode so feature-off adds no request.
 */
export const usePublishedSkillCatalog = (enabled: boolean) => {
  const invalidationRevision = useToolStore((state) =>
    enabled ? state.platformSkillCatalogInvalidationRevision : 'disabled',
  );

  return useClientDataSWR(
    enabled ? [PLATFORM_PUBLISHED_SKILL_CATALOG_KEY, invalidationRevision] : null,
    async () => {
      const epoch = useToolStore.getState().beginPlatformSkillCatalogRequest();
      try {
        const catalog = await platformSkillsService.getPublishedCatalog();
        useToolStore.getState().completePlatformSkillCatalogRequest(epoch, catalog);
        return catalog;
      } catch (error) {
        useToolStore.getState().failPlatformSkillCatalogRequest(epoch);
        throw error;
      }
    },
    { revalidateOnFocus: false },
  );
};

export const invalidatePublishedSkillCatalog = async (catalogRevision: string) => {
  useToolStore.getState().invalidatePlatformSkillCatalog(catalogRevision);
  await mutate(
    (key) => Array.isArray(key) && key[0] === PLATFORM_PUBLISHED_SKILL_CATALOG_KEY,
    undefined,
    { revalidate: false },
  );
};
