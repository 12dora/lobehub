import type { SkillManifest, SkillValidationIssue } from '../../contracts/skillCatalog';
import { SkillDependencyGraphWalk } from './dependencyGraphWalk';
import type { SkillCatalogValidatorOptions } from './validator';

export const validateSkillDependencyGraph = async (
  root: {
    manifest: SkillManifest;
    skillKey: string;
    version: string;
  },
  options: SkillCatalogValidatorOptions,
  pushIssue: (item: SkillValidationIssue) => void,
) => {
  await new SkillDependencyGraphWalk(root, options, pushIssue).validate();
};
