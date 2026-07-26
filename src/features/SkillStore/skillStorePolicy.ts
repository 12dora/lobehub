import type { AdminToolScopeCapabilities } from '@/features/AdminToolScope';

interface PersonalSkillCapabilities {
  canCreate: boolean;
  canDelete: boolean;
}

export const resolveSkillStoreCapabilities = (
  platform: AdminToolScopeCapabilities | undefined,
  personal: PersonalSkillCapabilities,
) => ({
  canCreate: platform?.canCreateSkill ?? personal.canCreate,
  canDelete: platform?.canDeleteSkill ?? personal.canDelete,
});

export const resolveSkillImportCapability = (
  hasPlatformOverride: boolean,
  platformCanCreate: boolean | undefined,
  personalCanCreate: boolean,
) => (hasPlatformOverride ? platformCanCreate === true : personalCanCreate);

interface RunSkillImportOptions {
  importSkill: () => Promise<void>;
  onComplete: () => void;
  onPersonalSuccess: () => void;
  platformOverride: boolean;
}

/**
 * The platform provider owns organization-import outcome feedback, including soft publication
 * failures. The shared modal only emits generic success for personal imports.
 */
export const runSkillImport = async ({
  importSkill,
  onComplete,
  onPersonalSuccess,
  platformOverride,
}: RunSkillImportOptions) => {
  await importSkill();
  if (!platformOverride) onPersonalSuccess();
  onComplete();
};
