// @vitest-environment node
import { builtinSkills } from '@lobechat/builtin-skills';
import { describe, expect, it } from 'vitest';

import { getBuiltinSkillDefinitions } from './builtinAdapter';

describe('production builtin Skill package', () => {
  it('never returns an invalid projection when loading production package assets', () => {
    // Some Vitest loaders cannot import Markdown and expose an empty string.
    // That environment must fail closed; Bun/production loaders with complete
    // assets must return the entire strictly parsed catalog.
    if (builtinSkills.some((skill) => skill.content.length === 0)) {
      expect(() => getBuiltinSkillDefinitions()).toThrow();
      return;
    }

    const definitions = getBuiltinSkillDefinitions();

    expect(definitions).toHaveLength(builtinSkills.length);
    expect(definitions.length).toBeGreaterThan(0);
    expect(definitions.every((definition) => definition.content.length > 0)).toBe(true);
    expect(definitions.every((definition) => definition.source === 'builtin')).toBe(true);
  });
});
