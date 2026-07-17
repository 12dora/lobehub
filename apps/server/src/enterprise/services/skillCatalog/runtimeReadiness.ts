import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { registerManagedResourceReadiness } from '../managedResourceReadiness';
import { getBuiltinSkillDefinitions } from './builtinAdapter';
import { SkillCatalogReadService } from './readService';

let registered = false;

export const isPublishedSkillCatalogExecutionReady = async (params: {
  catalog: Awaited<ReturnType<SkillCatalogReadService['getPublishedCatalog']>>;
  service: Pick<SkillCatalogReadService, 'resolvePinnedForExecution'> &
    Partial<Pick<SkillCatalogReadService, 'isPublishedCatalogExecutionReady'>>;
}): Promise<boolean> => {
  if (params.service.isPublishedCatalogExecutionReady) {
    return params.service.isPublishedCatalogExecutionReady(params.catalog);
  }
  if (params.catalog.skills.length === 0) return true;
  const resolved = await Promise.all(
    params.catalog.skills.map(async ({ checksum, skillKey, version }) => {
      const skill = await params.service.resolvePinnedForExecution({ checksum, skillKey, version });
      if (!skill || skill.skillKey !== skillKey || skill.version !== version) return false;
      if (skill.checksum !== checksum || skill.contentRef !== null) return false;
      return skill.resources.every(
        (resource) => resource.content !== undefined && resource.contentRef === undefined,
      );
    }),
  );
  return resolved.every(Boolean);
};

export const resolveSkillCatalogRuntimeReadiness = async (
  params: {
    db?: LobeChatDatabase;
    flags?: EnterpriseFeatureFlags;
    service?: Pick<SkillCatalogReadService, 'getPublishedCatalog' | 'resolvePinnedForExecution'> &
      Partial<Pick<SkillCatalogReadService, 'isPublishedCatalogExecutionReady'>>;
  } = {},
): Promise<boolean> => {
  const flags = params.flags ?? parseEnterpriseFeatureFlags(process.env);
  if (!flags.ENABLE_PLATFORM_MANAGED_SKILLS) return false;

  const db = params.db ?? (await getServerDB());
  const service =
    params.service ??
    new SkillCatalogReadService(db, { builtinSkills: getBuiltinSkillDefinitions() });
  const catalog = await service.getPublishedCatalog();
  return isPublishedSkillCatalogExecutionReady({ catalog, service });
};

/** Registers a lazy DB-backed probe; registration itself performs no I/O. */
export const ensureSkillCatalogReadinessRegistered = (): void => {
  if (registered) return;
  registered = true;
  registerManagedResourceReadiness('skills', () => resolveSkillCatalogRuntimeReadiness());
};

export const resetSkillCatalogReadinessRegistrationForTest = (): void => {
  registered = false;
};
