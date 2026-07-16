import type { ToolDetailType } from './features/SkillDetail';
import type { SkillViewMode } from './features/SkillList';

export interface SelectedTool {
  identifier: string;
  type: ToolDetailType;
}

export const resolveInitialToolSelection = (params: {
  builtinSkills: Array<{ identifier: string }>;
  builtinTools: Array<{ hidden?: boolean; identifier: string }>;
  installedBuiltinIds: string[];
  managed: boolean;
  platformSkills?: Array<{ skillKey: string }>;
  viewMode: SkillViewMode;
}): SelectedTool | null => {
  if (params.viewMode === 'connector') {
    if (params.managed) return null;
    const firstTool = params.builtinTools.find(
      (tool) => !tool.hidden && params.installedBuiltinIds.includes(tool.identifier),
    );
    return firstTool ? { identifier: firstTool.identifier, type: 'builtin' } : null;
  }

  if (params.managed) {
    const firstPlatformSkill = params.platformSkills?.[0];
    return firstPlatformSkill
      ? { identifier: firstPlatformSkill.skillKey, type: 'platform-skill' }
      : null;
  }

  const firstSkill = params.builtinSkills[0];
  return firstSkill ? { identifier: firstSkill.identifier, type: 'builtin-skill' } : null;
};
