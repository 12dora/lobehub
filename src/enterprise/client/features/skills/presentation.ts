import type { AgentPluginMode } from '@lobechat/types';

import type { PlatformSkillDistribution } from '@/types/platform/skills';
import { getPlatformSkillToggleMode, resolvePlatformSkillSelection } from '@/types/platform/skills';

export type PublishedSkillDistribution = PlatformSkillDistribution;

export const isPublishedSkillEnabled = (
  distribution: PublishedSkillDistribution,
  mode: AgentPluginMode,
): boolean => resolvePlatformSkillSelection(distribution, mode).available;

export const getPublishedSkillToggleMode = (
  distribution: PublishedSkillDistribution,
  enabled: boolean,
): AgentPluginMode | null => getPlatformSkillToggleMode(distribution, enabled);
