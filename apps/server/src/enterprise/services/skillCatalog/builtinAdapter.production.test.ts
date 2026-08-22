// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import type { BuiltinSkill } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { skillResourceContentChecksum } from '../../contracts/skillCatalog';
import { adaptBuiltinSkillDefinitions } from './builtinAdapter';

/**
 * Vitest's root `raw-md` plugin rewrites every `.md` import to `export default ""`.
 * Under that stub, `getBuiltinSkillDefinitions()` always sees empty package content
 * and fail-closes — which previously *masked* the resource-checksum regression
 * (empty content → throw for a different reason).
 *
 * This suite therefore loads production Markdown assets from disk and exercises
 * `adaptBuiltinSkillDefinitions` the same way production does when content is real.
 */
const packageSrc = path.join(process.cwd(), 'packages/builtin-skills/src');

const readMdTree = (dir: string, base = dir): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      Object.assign(out, readMdTree(full, base));
      continue;
    }
    if (!entry.endsWith('.md')) continue;
    const rel = path.relative(base, full).split(path.sep).join('/');
    out[rel] = readFileSync(full, 'utf8');
  }
  return out;
};

/** Disk-backed skills that ship Markdown (task, verify, document-processing). */
const loadMarkdownBuiltinSkills = (): BuiltinSkill[] => {
  const skills: BuiltinSkill[] = [];

  for (const dirName of ['task', 'verify', 'document-processing'] as const) {
    const skillDir = path.join(packageSrc, dirName);
    const files = readMdTree(skillDir);
    const content = files['SKILL.md'];
    expect(content, `${dirName}/SKILL.md must exist on disk`).toBeTruthy();
    expect(content!.length, `${dirName}/SKILL.md must be non-empty`).toBeGreaterThan(0);

    const resources: NonNullable<BuiltinSkill['resources']> = {};
    for (const [rel, body] of Object.entries(files)) {
      if (rel === 'SKILL.md') continue;
      // Mirror package conventions: task drops `.md`; verify keeps it.
      const resourcePath = dirName === 'task' ? rel.replace(/\.md$/i, '') : rel;
      resources[resourcePath] = {
        content: body,
        fileHash: '',
        size: new TextEncoder().encode(body).byteLength,
      };
    }

    skills.push({
      content: content!,
      description: `${dirName} skill (disk-loaded for production adapter test)`,
      identifier: dirName,
      name: dirName,
      resources,
      source: 'builtin',
    });
  }

  return skills;
};

describe('production builtin Skill package', () => {
  it('strictly parses disk-backed production assets with content-bound resource checksums', () => {
    const skills = loadMarkdownBuiltinSkills();

    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((skill) => skill.content.length > 0)).toBe(true);
    expect(
      skills.some((skill) => Object.keys(skill.resources ?? {}).length > 0),
      'at least one production skill must carry resources',
    ).toBe(true);

    // Must not throw ZodError on resource checksum binding.
    const definitions = adaptBuiltinSkillDefinitions(skills);

    expect(definitions).toHaveLength(skills.length);
    expect(definitions.every((definition) => definition.source === 'builtin')).toBe(true);
    expect(definitions.every((definition) => definition.content.length > 0)).toBe(true);

    let resourceCount = 0;
    for (const definition of definitions) {
      for (const resource of definition.resources ?? []) {
        resourceCount += 1;
        expect(resource.content).toEqual(expect.any(String));
        expect(resource.checksum).toBe(skillResourceContentChecksum(resource.content!));
        expect(resource.checksum).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    expect(resourceCount).toBeGreaterThan(0);
  });
});
