import { builtinSkills } from '@lobechat/builtin-skills';

import { checksumPayload, platformSkillVersionChecksum } from '@/database/models/platform';

import type { SkillManifest, SkillResource } from '../../contracts/skillCatalog';
import type { BuiltinSkillDefinition } from './readService';

const manifestForBuiltin = (skill: (typeof builtinSkills)[number]): SkillManifest => ({
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

const resourcesForBuiltin = (skill: (typeof builtinSkills)[number]): SkillResource[] =>
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

export const getBuiltinSkillDefinitions = (): BuiltinSkillDefinition[] =>
  builtinSkills.map((skill) => {
    const manifest = manifestForBuiltin(skill);
    const resources = resourcesForBuiltin(skill);
    return {
      checksum: platformSkillVersionChecksum({ content: skill.content, manifest, resources }),
      content: skill.content,
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
