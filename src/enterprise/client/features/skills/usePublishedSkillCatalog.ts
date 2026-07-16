'use client';

import { useClientDataSWR } from '@/libs/swr';
import { useToolStore } from '@/store/tool';

import { platformSkillsService } from '../../services/platformSkills';

export const PLATFORM_PUBLISHED_SKILL_CATALOG_KEY = 'platform.skills.getPublishedCatalog';

/**
 * Fetches the exact public catalog used by the server runtime. Callers must
 * keep this disabled outside managed Skill mode so feature-off adds no request.
 */
export const usePublishedSkillCatalog = (enabled: boolean) =>
  useClientDataSWR(
    enabled ? [PLATFORM_PUBLISHED_SKILL_CATALOG_KEY] : null,
    () => platformSkillsService.getPublishedCatalog(),
    {
      onSuccess: (catalog) => useToolStore.getState().setPlatformSkillCatalog(catalog),
      revalidateOnFocus: false,
    },
  );
