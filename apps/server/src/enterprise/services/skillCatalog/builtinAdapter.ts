import { builtinSkills } from '@lobechat/builtin-skills';
import type { BuiltinSkill } from '@lobechat/types';

import { checksumPayload, platformSkillVersionChecksum } from '@/database/models/platform';

import type { SkillManifest, SkillResource } from '../../contracts/skillCatalog';
import { type BuiltinSkillDefinition, builtinSkillDefinitionsSchema } from './readService';

const manifestForBuiltin = (skill: BuiltinSkill): SkillManifest => ({
  description: skill.description,
  displayName: skill.title ?? skill.name,
  localizedDescriptions: {},
  localizedDisplayNames: {},
  permissions: {
    filesystem: 'read',
    network: { allowedHosts: [], enabled: false },
    tools: { allow: [] },
  },
  skillDependencies: [],
  toolDependencies: [],
});

const resourcesForBuiltin = (skill: BuiltinSkill): SkillResource[] =>
  Object.entries(skill.resources ?? {}).flatMap(([path, resource]) => {
    if (typeof resource.content !== 'string') return [];
    return [
      {
        checksum: checksumPayload({ content: resource.content }),
        content: resource.content,
        mediaType: 'text/plain',
        path,
        sizeBytes: new TextEncoder().encode(resource.content).byteLength,
      },
    ];
  });

export const adaptBuiltinSkillDefinitions = (
  skills: readonly BuiltinSkill[],
): BuiltinSkillDefinition[] => {
  const definitions = skills.map((skill) => {
    const manifest = manifestForBuiltin(skill);
    const resources = resourcesForBuiltin(skill);
    return {
      checksum: platformSkillVersionChecksum({ content: skill.content, manifest, resources }),
      content: skill.content,
      contentRef: null,
      description: skill.description,
      displayName: skill.title ?? skill.name,
      distribution: 'default',
      manifest,
      resources,
      skillKey: skill.identifier,
      source: 'builtin',
      version: '0.0.0',
    };
  });

  // Validate at the loader boundary so invalid package assets never reach an
  // admin mutation or runtime catalog constructor.
  return builtinSkillDefinitionsSchema.parse(definitions) as BuiltinSkillDefinition[];
};

export const getBuiltinSkillDefinitions = (): BuiltinSkillDefinition[] =>
  adaptBuiltinSkillDefinitions(builtinSkills);
