// @vitest-environment node
import type { BuiltinSkill } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import { adaptBuiltinSkillDefinitions, getBuiltinSkillDefinitions } from './builtinAdapter';

vi.mock('@lobechat/builtin-skills', () => ({
  builtinSkills: [
    {
      content: '',
      description: 'Broken package asset',
      identifier: 'broken-package-skill',
      name: 'Broken package skill',
      source: 'builtin',
    },
  ],
}));

const builtin = (overrides: Partial<BuiltinSkill> = {}): BuiltinSkill => ({
  content: '# Safe builtin Skill',
  description: 'A safe builtin Skill',
  identifier: 'safe-builtin',
  name: 'Safe builtin',
  source: 'builtin',
  ...overrides,
});

describe('adaptBuiltinSkillDefinitions', () => {
  it('returns a strict execution definition for a valid builtin package asset', () => {
    const definitions = adaptBuiltinSkillDefinitions([
      builtin({
        resources: {
          'references/guide.md': { content: 'guide', fileHash: 'guide-hash', size: 5 },
        },
        title: 'Safe builtin title',
      }),
    ]);

    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toMatchObject({
      content: '# Safe builtin Skill',
      displayName: 'Safe builtin title',
      skillKey: 'safe-builtin',
      source: 'builtin',
      version: '0.0.0',
    });
    expect(definitions[0]?.resources).toEqual([
      expect.objectContaining({ content: 'guide', path: 'references/guide.md', sizeBytes: 5 }),
    ]);
    expect(definitions[0]?.checksum).toMatch(/^[a-f\d]{64}$/);
  });

  it('fails closed on empty content before a definition reaches admin or runtime services', () => {
    expect(() => adaptBuiltinSkillDefinitions([builtin({ content: '' })])).toThrow();
  });

  it('enforces the bounded builtin catalog at the package loader boundary', () => {
    const skills = Array.from({ length: 101 }, (_, index) =>
      builtin({ identifier: `safe-builtin-${index}` }),
    );

    expect(() => adaptBuiltinSkillDefinitions(skills)).toThrow();
  });
});

describe('getBuiltinSkillDefinitions', () => {
  it('strictly parses the imported package assets instead of returning an invalid mock', () => {
    expect(() => getBuiltinSkillDefinitions()).toThrow();
  });
});
