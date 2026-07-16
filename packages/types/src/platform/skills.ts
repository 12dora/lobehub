import type { AgentPluginMode } from '../agent/pluginConfig';

export const PLATFORM_SKILL_DISTRIBUTIONS = ['mandatory', 'default', 'optional'] as const;
export type PlatformSkillDistribution = (typeof PLATFORM_SKILL_DISTRIBUTIONS)[number];

export interface PlatformPublishedSkill {
  checksum: string;
  description: string | null;
  displayName: string;
  distribution: PlatformSkillDistribution;
  skillKey: string;
  source: 'builtin' | 'uploaded';
  version: string;
}

export interface PlatformPublishedSkillCatalog {
  revision: string;
  skills: PlatformPublishedSkill[];
}

export interface PlatformSkillPinnedRef {
  checksum: string;
  skillKey: string;
  version: string;
}

export interface PlatformSkillOperationSnapshot {
  mandatorySkillIds?: string[];
  refs: PlatformSkillPinnedRef[];
  revision: string;
  /** Client operations retain immutable public metadata for repeated context assembly. */
  skills?: PlatformPublishedSkill[];
}

export interface PlatformSkillSelection {
  /** Content is injected immediately for a pinned selection. */
  activated: boolean;
  /** Included in the operation candidate pool. */
  available: boolean;
  /** Whether a user may change this per-agent selection. */
  mutable: boolean;
}

/** Shared client/server interpretation of catalog distribution + agent tri-state. */
export const resolvePlatformSkillSelection = (
  distribution: PlatformSkillDistribution,
  mode: AgentPluginMode,
): PlatformSkillSelection => {
  if (distribution === 'mandatory') {
    return { activated: false, available: true, mutable: false };
  }
  if (distribution === 'optional') {
    const selected = mode === 'pinned';
    return { activated: selected, available: selected, mutable: true };
  }
  return {
    activated: mode === 'pinned',
    available: mode !== 'disabled',
    mutable: true,
  };
};

export const getPlatformSkillToggleMode = (
  distribution: PlatformSkillDistribution,
  enabled: boolean,
): AgentPluginMode | null => {
  if (distribution === 'mandatory') return null;
  if (!enabled) return 'disabled';
  return distribution === 'optional' ? 'pinned' : 'auto';
};
