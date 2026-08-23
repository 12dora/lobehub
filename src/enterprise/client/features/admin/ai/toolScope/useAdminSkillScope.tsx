import type { AdminToolScopeSectionParams } from './toolScopeSection';
import { useAdminSkillCatalog } from './useAdminSkillCatalog';
import { useAdminSkillLibrary } from './useAdminSkillLibrary';
import { useBuiltinSkillDistribution } from './useBuiltinSkillDistribution';
import { useOrgSkillDetailSource } from './useOrgSkillDetailSource';

type UseAdminSkillScopeParams = AdminToolScopeSectionParams;

/**
 * Skill half of the admin tool-scope datasource: the org catalog, builtin
 * distribution decisions, org skill import/delete, and the detail datasource
 * the parity UI renders with.
 */
export const useAdminSkillScope = ({
  capabilities,
  enabled,
  notifications,
}: UseAdminSkillScopeParams) => {
  const { error, isLoading, orgSkills, retry, skillRowsByKey } = useAdminSkillCatalog(enabled);

  const {
    canSetBuiltinSkillDistribution,
    getBuiltinSkillDistribution,
    isBuiltinSkillEnabled,
    setBuiltinSkillDistribution,
    toggleBuiltinSkill,
  } = useBuiltinSkillDistribution({
    capabilities,
    notifications,
    retry,
    skillRowsByKey,
  });

  const { deleteOrgSkill, importFromGithub, importFromUrl, importFromZip, installFromMarket } =
    useAdminSkillLibrary({ capabilities, notifications, retry });

  const useOrgSkillDetail = useOrgSkillDetailSource();

  return {
    canSetBuiltinSkillDistribution,
    deleteOrgSkill,
    error,
    getBuiltinSkillDistribution,
    importFromGithub,
    importFromUrl,
    importFromZip,
    installFromMarket,
    isBuiltinSkillEnabled,
    isLoading,
    orgSkills,
    retry,
    setBuiltinSkillDistribution,
    toggleBuiltinSkill,
    useOrgSkillDetail,
  };
};
