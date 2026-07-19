// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BrandingBaseline } from './brandingLiterals';
import { BRANDING_BASELINE_POLICY, MAX_BRANDING_TEXT_FILE_BYTES } from './brandingLiterals';
import { runBrandingScanCli } from './scan-branding-literals';

const execFileAsync = promisify(execFile);
const emptyBaseline: BrandingBaseline = {
  entries: [],
  policy: BRANDING_BASELINE_POLICY,
  version: 2,
};
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(scriptDirectory, 'scan-branding-literals.ts');
const actualRepositoryRoot = path.resolve(scriptDirectory, '../..');

describe('branding literal scan CLI', () => {
  let repositoryRoot: string;

  beforeEach(async () => {
    repositoryRoot = await mkdtemp(path.join(tmpdir(), 'aihub-branding-scan-'));
    await Promise.all(
      ['apps', 'locales', 'packages', 'public', 'src', 'scripts/enterprise'].map((directory) =>
        mkdir(path.join(repositoryRoot, directory), { recursive: true }),
      ),
    );
    await Promise.all(
      ['index.auth.html', 'index.html', 'index.mobile.html'].map((file) =>
        writeFile(path.join(repositoryRoot, file), '<!doctype html>', 'utf8'),
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

  const run = (args: string[] = []) =>
    runBrandingScanCli(['--root', repositoryRoot, ...args], repositoryRoot);

  it('returns deterministic exit codes, atomically updates, and keeps line moves stable', async () => {
    const sourcePath = path.join(repositoryRoot, 'src/title.ts');
    await writeFile(sourcePath, `export const title = 'LobeHub';\n`, 'utf8');

    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
    expect(first.code).toBe(1);
    expect(first.output).toContain('new-user-visible-literal');

    expect((await run(['--update-baseline'])).code).toBe(0);
    expect(
      (await readdir(path.join(repositoryRoot, 'scripts/enterprise'))).every(
        (file) => !file.endsWith('.tmp'),
      ),
    ).toBe(true);
    await writeFile(sourcePath, `\n\nexport const title = 'LobeHub';\n`, 'utf8');
    expect((await run()).code).toBe(0);

    await writeFile(sourcePath, `export const title = 'AIHub';\n`, 'utf8');
    const stale = await run();
    expect(stale.code).toBe(1);
    expect(stale.output).toContain('baseline-occurrence-missing');
  });

  it('rejects equal-count replacement, swapping, moving, renaming, and path case changes', async () => {
    const sourcePath = path.join(repositoryRoot, 'src/Title.ts');
    await writeFile(sourcePath, `export const title = 'Old LobeHub';`, 'utf8');
    await run(['--update-baseline']);
    await writeFile(sourcePath, `export const title = 'New LobeHub';`, 'utf8');
    let result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('baseline-occurrence-missing');
    expect(result.output).toContain('new-user-visible-literal');

    await writeFile(
      sourcePath,
      `export const labels = { a: 'First LobeHub', b: 'Second LobeHub' };`,
      'utf8',
    );
    await run(['--update-baseline']);
    await writeFile(
      sourcePath,
      `export const labels = { a: 'Second LobeHub', b: 'First LobeHub' };`,
      'utf8',
    );
    expect((await run()).code).toBe(1);

    await writeFile(sourcePath, `export const title = 'LobeHub';`, 'utf8');
    await run(['--update-baseline']);
    const lowerCasePath = path.join(repositoryRoot, 'src/title.ts');
    await rename(sourcePath, lowerCasePath);
    expect((await run()).code).toBe(1);

    const movedPath = path.join(repositoryRoot, 'packages/title.ts');
    await rename(lowerCasePath, movedPath);
    result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('packages/title.ts');
  });

  it('treats control-flow and DOM ancestry changes as reviewed moves', async () => {
    const branchPath = path.join(repositoryRoot, 'src/branch.ts');
    await writeFile(branchPath, `if (a) render('LobeHub');`, 'utf8');
    await run(['--update-baseline']);
    await writeFile(branchPath, `if (b) render('LobeHub');`, 'utf8');

    let result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('baseline-occurrence-missing');
    expect(result.output).toContain('new-user-visible-literal');

    await rm(branchPath);
    const htmlPath = path.join(repositoryRoot, 'public/view.html');
    await writeFile(htmlPath, '<section id="first"><p>LobeChat</p></section>', 'utf8');
    await run(['--update-baseline']);
    await writeFile(htmlPath, '<section id="second"><p>LobeChat</p></section>', 'utf8');

    result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('baseline-occurrence-missing');
    expect(result.output).toContain('new-user-visible-literal');
  });

  it('scans locale, root HTML, and public HTML runtime roots and exits one for additions', async () => {
    await mkdir(path.join(repositoryRoot, 'locales/en-US'), { recursive: true });
    await Promise.all([
      writeFile(
        path.join(repositoryRoot, 'locales/en-US/runtime.json'),
        JSON.stringify({ title: 'LobeHub locale' }),
        'utf8',
      ),
      writeFile(path.join(repositoryRoot, 'index.html'), '<title>LobeHub root</title>', 'utf8'),
      writeFile(
        path.join(repositoryRoot, 'public/runtime.html'),
        '<title>LobeChat public</title>',
        'utf8',
      ),
    ]);

    const result = await run();
    expect(result.code).toBe(1);
    expect(result.output).toContain('locales/en-US/runtime.json');
    expect(result.output).toContain('index.html');
    expect(result.output).toContain('public/runtime.html');
  });

  it('fails closed for unknown files, invalid UTF-8, fake binaries, and oversized text', async () => {
    await Promise.all([
      writeFile(path.join(repositoryRoot, 'src/unknown.data'), 'no brand', 'utf8'),
      writeFile(path.join(repositoryRoot, 'src/disguised.txt'), new Uint8Array([0xff, 0xfe])),
      writeFile(path.join(repositoryRoot, 'src/fake.png'), 'plain text', 'utf8'),
      writeFile(
        path.join(repositoryRoot, 'src/large.txt'),
        Buffer.alloc(MAX_BRANDING_TEXT_FILE_BYTES + 1, 0x20),
      ),
      writeFile(
        path.join(repositoryRoot, 'src/valid.png'),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
      writeFile(
        path.join(repositoryRoot, 'src/payload.png'),
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.from('LobeHub'),
        ]),
      ),
    ]);

    const result = await run();
    expect(result.code).toBe(2);
    expect(result.output).toContain('unclassified file extension');
    expect(result.output).toContain('invalid UTF-8');
    expect(result.output).toContain('invalid .png binary signature');
    expect(result.output).toContain('valid .png magic contains suspicious branding payload');
    expect(result.output).toContain('byte limit');
    expect(result.output).not.toContain('valid.png');
  });

  it('rejects file symlinks with exit two', async () => {
    await writeFile(
      path.join(repositoryRoot, 'src/target.ts'),
      `export const value = 'AIHub';`,
      'utf8',
    );
    await symlink('target.ts', path.join(repositoryRoot, 'src/link.ts'));

    const result = await run();
    expect(result.code).toBe(2);
    expect(result.output).toContain('symbolic links are not valid branding scan targets');
  });

  it('rejects baseline symlinks with exit two', async () => {
    const baselinePath = path.join(
      repositoryRoot,
      'scripts/enterprise/branding-literals-baseline.json',
    );
    const realBaselinePath = path.join(repositoryRoot, 'scripts/enterprise/real-baseline.json');
    await writeFile(realBaselinePath, JSON.stringify(emptyBaseline), 'utf8');
    await rm(baselinePath);
    await symlink('real-baseline.json', baselinePath);

    const result = await run();
    expect(result.code).toBe(2);
    expect(result.output).toContain('baseline must be a regular non-symlink file');
  });

  it('rejects repository-root symlinks with exit two', async () => {
    const linkParent = await mkdtemp(path.join(tmpdir(), 'aihub-branding-root-link-'));
    const linkPath = path.join(linkParent, 'repository');
    try {
      await symlink(repositoryRoot, linkPath);
      const result = await runBrandingScanCli(['--root', linkPath], linkPath);
      expect(result.code).toBe(2);
      expect(result.output).toContain('repository root must be a real directory, not a symlink');
    } finally {
      await rm(linkParent, { force: true, recursive: true });
    }
  });

  it('propagates a new literal as the process exit code', async () => {
    await writeFile(
      path.join(repositoryRoot, 'src/title.ts'),
      `export const title = 'LobeChat';`,
      'utf8',
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

  it('validates the checked-in repository baseline', async () => {
    const result = await execFileAsync('bun', ['run', scriptPath, '--root', actualRepositoryRoot], {
      cwd: actualRepositoryRoot,
      maxBuffer: 1024 * 1024,
    });
    expect(result.stdout).toContain('runtime branding literals ok');
  }, 30_000);
});
