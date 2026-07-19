// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BrandingBaseline } from './brandingLiterals';
import { BRANDING_BASELINE_POLICY } from './brandingLiterals';
import { runBrandingScanCli } from './scan-branding-literals';

const execFileAsync = promisify(execFile);
const emptyBaseline: BrandingBaseline = {
  entries: [],
  policy: BRANDING_BASELINE_POLICY,
  version: 1,
};

describe('branding literal scan CLI', () => {
  let repositoryRoot: string;

  beforeEach(async () => {
    repositoryRoot = await mkdtemp(path.join(tmpdir(), 'aihub-branding-scan-'));
    await Promise.all(
      ['apps', 'packages', 'src', 'scripts/enterprise'].map((directory) =>
        mkdir(path.join(repositoryRoot, directory), { recursive: true }),
      ),
    );
    await writeFile(
      path.join(repositoryRoot, 'scripts/enterprise/branding-literals-baseline.json'),
      JSON.stringify(emptyBaseline),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(repositoryRoot, { force: true, recursive: true });
  });

  const writeBaseline = async (entries: typeof emptyBaseline.entries) => {
    await writeFile(
      path.join(repositoryRoot, 'scripts/enterprise/branding-literals-baseline.json'),
      JSON.stringify({ ...emptyBaseline, entries }),
      'utf8',
    );
  };

  it('returns deterministic policy exit codes and keeps line moves baseline-stable', async () => {
    const sourcePath = path.join(repositoryRoot, 'src/title.ts');
    await writeFile(sourcePath, `export const title = 'LobeHub';\n`, 'utf8');

    const first = await runBrandingScanCli(['--root', repositoryRoot], repositoryRoot);
    const second = await runBrandingScanCli(['--root', repositoryRoot], repositoryRoot);
    expect(first).toEqual(second);
    expect(first.code).toBe(1);
    expect(first.output).toContain('src/title.ts:1:22 [LobeHub] new-user-visible-literal');

    await writeBaseline([
      { LobeHub: 1, category: 'legacy-user-visible' as const, path: 'src/title.ts' },
    ]);
    await writeFile(sourcePath, `\n\nexport const title = 'LobeHub';\n`, 'utf8');
    const allowed = await runBrandingScanCli(['--root', repositoryRoot], repositoryRoot);
    expect(allowed.code).toBe(0);

    await writeFile(sourcePath, `export const title = 'AIHub';\n`, 'utf8');
    const stale = await runBrandingScanCli(['--root', repositoryRoot], repositoryRoot);
    expect(stale.code).toBe(1);
    expect(stale.output).toContain('baseline-count-decreased');
  });

  it('honors explicit skip boundaries and fails closed for an unknown text extension', async () => {
    await Promise.all([
      mkdir(path.join(repositoryRoot, 'src/docs'), { recursive: true }),
      mkdir(path.join(repositoryRoot, 'src/fixtures'), { recursive: true }),
      mkdir(path.join(repositoryRoot, 'src/generated'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(repositoryRoot, 'src/docs/readme.ts'), `'LobeHub'`, 'utf8'),
      writeFile(path.join(repositoryRoot, 'src/fixtures/data.ts'), `'LobeHub'`, 'utf8'),
      writeFile(path.join(repositoryRoot, 'src/generated/output.ts'), `'LobeHub'`, 'utf8'),
      writeFile(path.join(repositoryRoot, 'src/image.png'), 'LobeHub', 'utf8'),
      writeFile(path.join(repositoryRoot, 'src/disguised.unknown'), new Uint8Array([0xff, 0xfe])),
      writeFile(path.join(repositoryRoot, 'src/view.unknown'), 'LobeHub', 'utf8'),
    ]);

    const result = await runBrandingScanCli(['--root', repositoryRoot], repositoryRoot);
    expect(result.code).toBe(2);
    expect(result.output).toContain('invalid UTF-8');
    expect(result.output).toContain('unsupported text extension');
    expect(result.output).not.toContain('docs/readme');
    expect(result.output).not.toContain('fixtures/data');
    expect(result.output).not.toContain('generated/output');
    expect(result.output).not.toContain('image.png');
  });

  it('rejects a baseline path outside the repository root', async () => {
    const result = await runBrandingScanCli(
      ['--root', repositoryRoot, '--baseline', '%252e%252e/outside.json'],
      repositoryRoot,
    );

    expect(result.code).toBe(2);
    expect(result.output).toContain('repository path traversal is not allowed');
  });

  it('propagates the policy result as the process exit code', async () => {
    await writeFile(
      path.join(repositoryRoot, 'src/title.ts'),
      `export const title = 'LobeChat';`,
      'utf8',
    );
    const scriptPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'scan-branding-literals.ts',
    );

    let exitCode: number | string | undefined;
    let stderr = '';
    try {
      await execFileAsync('bun', ['run', scriptPath, '--root', repositoryRoot], {
        cwd: repositoryRoot,
      });
    } catch (error) {
      const executionError = error as { code?: number | string; stderr?: string };
      exitCode = executionError.code;
      stderr = executionError.stderr ?? '';
    }

    expect(exitCode).toBe(1);
    expect(stderr).toContain('new-user-visible-literal');
  });
});
