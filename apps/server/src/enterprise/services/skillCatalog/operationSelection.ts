import { type AgentPluginEntry, getPluginMode } from '@lobechat/types';

import { resolvePlatformSkillSelection } from '@/types/platform/skills';

import type { PlatformSkillPinnedRef, PublishedSkill } from '../../contracts/skillCatalog';

export const selectPlatformOperationSkills = (
  skills: PublishedSkill[],
  plugins?: AgentPluginEntry[],
) =>
  skills.flatMap((skill) => {
    const selection = resolvePlatformSkillSelection(
      skill.distribution,
      getPluginMode(plugins, skill.skillKey),
    );
    return selection.available ? [{ selection, skill }] : [];
  });

const refKey = (ref: PlatformSkillPinnedRef) => `${ref.skillKey}\0${ref.version}\0${ref.checksum}`;

export const hasExactPlatformSkillRefs = (
  actual: PlatformSkillPinnedRef[],
  expected: PlatformSkillPinnedRef[],
) => {
  if (actual.length !== expected.length) return false;
  const actualKeys = actual.map(refKey).sort();
  const expectedKeys = expected.map(refKey).sort();
  return actualKeys.every((value, index) => value === expectedKeys[index]);
};
