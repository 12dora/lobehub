import type {
  AdminSkillGetDependentsInput,
  AdminSkillListInput,
  AdminSkillListVersionsInput,
} from './types';

export const ADMIN_SKILL_LIST_KEY = 'admin.skills.list' as const;
export const ADMIN_SKILL_GET_KEY = 'admin.skills.get' as const;
export const ADMIN_SKILL_VERSION_KEY = 'admin.skills.getVersion' as const;
export const ADMIN_SKILL_VERSIONS_KEY = 'admin.skills.listVersions' as const;
export const ADMIN_SKILL_DEPENDENTS_KEY = 'admin.skills.getDependents' as const;

export const buildAdminSkillListKey = (input: AdminSkillListInput) =>
  [
    ADMIN_SKILL_LIST_KEY,
    input.cursor ?? '',
    input.distribution ?? '',
    input.enabled ?? '',
    input.limit,
    input.query ?? '',
    input.source ?? '',
    input.status ?? '',
  ] as const;

export const buildAdminSkillGetKey = (id: string) => [ADMIN_SKILL_GET_KEY, id] as const;

export const buildAdminSkillVersionKey = (skillId: string, versionId: string) =>
  [ADMIN_SKILL_VERSION_KEY, skillId, versionId] as const;

export const buildAdminSkillVersionsKey = (input: AdminSkillListVersionsInput) =>
  [ADMIN_SKILL_VERSIONS_KEY, input.skillId, input.cursor ?? '', input.limit] as const;

export const buildAdminSkillDependentsKey = (input: AdminSkillGetDependentsInput) =>
  [
    ADMIN_SKILL_DEPENDENTS_KEY,
    input.skillId,
    input.versionId ?? '',
    input.cursor ?? '',
    input.limit,
  ] as const;
