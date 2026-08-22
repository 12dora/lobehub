import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SANDBOX_PREINSTALLED_PIP_PACKAGES } from './preinstalled';

const dockerfilePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../Dockerfile.sandbox',
);

const parseDockerfilePipPackages = (source: string): string[] => {
  const packages: string[] = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    if (!inBlock) {
      if (line.includes('--upgrade')) continue;
      if (/pip install --no-cache-dir\s*(?:\\\s*)?$/.test(line.trimEnd())) {
        inBlock = true;
      }
      continue;
    }
    const match = line.match(/^\s+([A-Z0-9][\w.-]*)\s*(?:\\\s*)?$/i);
    if (!match?.[1]) {
      inBlock = false;
      continue;
    }
    packages.push(match[1].toLowerCase().replaceAll('_', '-'));
    if (!line.trimEnd().endsWith('\\')) inBlock = false;
  }
  return packages;
};

describe('SANDBOX_PREINSTALLED_PIP_PACKAGES', () => {
  it('matches Dockerfile.sandbox pip install block (lowercase, pip-normalized, alphabetical)', () => {
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const fromDockerfile = parseDockerfilePipPackages(dockerfile);
    expect(fromDockerfile).toEqual([...SANDBOX_PREINSTALLED_PIP_PACKAGES]);
    expect(fromDockerfile).toEqual([...fromDockerfile].sort((a, b) => a.localeCompare(b)));
  });
});
