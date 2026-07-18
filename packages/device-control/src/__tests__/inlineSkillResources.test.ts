import { createRequire } from 'node:module';
import path from 'node:path';

import {
  validateInlineSkillOperationPayloads,
  validateInlineSkillResourcePaths,
} from '@lobechat/device-control/inlineSkillResources';
import { describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const resolveModule = (id: string) => requireModule.resolve(id);

const resource = (path: string, content = 'x') => ({
  checksum: 'a'.repeat(64),
  content,
  mediaType: 'text/plain',
  path,
  sizeBytes: new TextEncoder().encode(content).byteLength,
});

describe('inline Skill operation payload validation', () => {
  it('resolves the browser-safe public entrypoint directly to the pure validation module', () => {
    const resolvedEntry = resolveModule('@lobechat/device-control/inlineSkillResources');
    expect(resolvedEntry.endsWith(path.join('src', 'inlineSkillResources.ts'))).toBe(true);
  });

  it.each([
    ['в.txt', 'ᲀ.txt'],
    ['ι.txt', 'ͅ.txt'],
  ])('rejects non-ASCII case-fold edge paths %s and %s', (left, right) => {
    expect(() => validateInlineSkillResourcePaths([left, right])).toThrow(
      'Unsafe inline Skill resource path',
    );
  });

  it('counts every SKILL.md across all activated Skills', () => {
    const payloads = [0, 1].map((group) => ({
      resources: Array.from({ length: 50 }, (_, index) => resource(`group-${group}/${index}.txt`)),
      skillContent: '# Skill',
    }));

    expect(() => validateInlineSkillOperationPayloads(payloads)).toThrow('file count exceeds 100');
  });

  it('applies the 8 MiB limit across all activated Skills', () => {
    const oneMiB = 'x'.repeat(1024 * 1024);
    const payloads = [0, 1].map((group) => ({
      resources: Array.from({ length: 4 }, (_, index) =>
        resource(`group-${group}/${index}.txt`, oneMiB),
      ),
      skillContent: '# Skill',
    }));

    expect(() => validateInlineSkillOperationPayloads(payloads)).toThrow(
      'operation exceeds 8388608 bytes',
    );
  });
});
