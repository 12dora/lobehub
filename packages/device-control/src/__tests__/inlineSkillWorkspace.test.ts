import { createHash } from 'node:crypto';
import { access, chmod, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetInlineSkillWorkspacesForTests,
  cleanupInlineSkillWorkspace,
  hashInlineSkillContent,
  prepareInlineSkillWorkspace,
} from '../inlineSkillWorkspace';

const roots: string[] = [];
const checksum = 'a'.repeat(64);

const resource = (resourcePath: string, content = 'print("ok")') => ({
  checksum: hashInlineSkillContent(content),
  content,
  mediaType: 'text/x-python',
  path: resourcePath,
  sizeBytes: new TextEncoder().encode(content).byteLength,
});

const params = (resources = [resource('scripts/run.py')]) => ({
  checksum,
  operationId: 'operation-1',
  resources,
  skillContent: '# Managed Skill',
  skillKey: '../../must-never-enter-a-path',
  version: '1.0.0',
});

const makeRoot = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inline-skill-test-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  __resetInlineSkillWorkspacesForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('inline Skill operation workspace', () => {
  it('materializes exact text in a private operation/checksum workspace and cleans it up', async () => {
    const root = await makeRoot();
    const result = await prepareInlineSkillWorkspace(params(), { cacheRoot: root });

    expect(result).toMatchObject({ success: true });
    expect(result.workspaceDir).toContain(checksum.slice(0, 24));
    expect(result.workspaceDir).not.toContain('must-never-enter');
    expect(await readFile(path.join(result.workspaceDir!, 'scripts/run.py'), 'utf8')).toBe(
      'print("ok")',
    );
    expect((await lstat(result.workspaceDir!)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(result.workspaceDir!, 'scripts/run.py'))).mode & 0o777).toBe(
      0o600,
    );

    await cleanupInlineSkillWorkspace({ workspaceId: result.workspaceId! });
    await expect(access(result.workspaceDir!)).rejects.toThrow();
  });

  it('rejects same-size tampered content whose checksum does not match the bytes', async () => {
    const root = await makeRoot();
    const honest = 'print("ok")';
    const tampered = 'print("no")'; // same byte length, different payload
    expect(new TextEncoder().encode(honest).byteLength).toBe(
      new TextEncoder().encode(tampered).byteLength,
    );

    const result = await prepareInlineSkillWorkspace(
      params([
        {
          // Declare the honest digest while shipping tampered body.
          checksum: hashInlineSkillContent(honest),
          content: tampered,
          mediaType: 'text/x-python',
          path: 'scripts/run.py',
          sizeBytes: new TextEncoder().encode(tampered).byteLength,
        },
      ]),
      { cacheRoot: root },
    );

    expect(result).toMatchObject({
      error: expect.stringContaining('integrity check failed'),
      success: false,
    });
    // No workspace directory should survive a failed integrity check.
    const entries = await import('node:fs/promises').then((fs) => fs.readdir(root));
    expect(entries).toHaveLength(0);
  });

  it('keeps a failed deletion retryable and only drops map state after rm succeeds', async () => {
    const root = await makeRoot();
    const removePath = vi
      .fn()
      .mockRejectedValueOnce(new Error('EBUSY'))
      .mockImplementation(async (target: string) => {
        await rm(target, { force: true, recursive: true });
      });

    const result = await prepareInlineSkillWorkspace(params(), {
      cacheRoot: root,
      removePath,
    });
    expect(result.success).toBe(true);

    await expect(
      cleanupInlineSkillWorkspace({ workspaceId: result.workspaceId! }, { removePath }),
    ).rejects.toThrow('EBUSY');
    // Workspace files must still exist so a retry can clean them up.
    await expect(access(result.workspaceDir!)).resolves.toBeUndefined();

    await expect(
      cleanupInlineSkillWorkspace({ workspaceId: result.workspaceId! }, { removePath }),
    ).resolves.toEqual({ success: true });
    await expect(access(result.workspaceDir!)).rejects.toThrow();
    expect(removePath).toHaveBeenCalledTimes(2);
  });

  it('cancels the TTL timer on successful manual cleanup', async () => {
    const root = await makeRoot();
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const cancelSchedule = vi.fn((timer: ReturnType<typeof setTimeout>) => {
      clearTimeout(timer);
    });
    const schedule = vi.fn((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timers.push(timer);
      return timer;
    });

    const result = await prepareInlineSkillWorkspace(params(), {
      cacheRoot: root,
      cancelSchedule,
      schedule,
      ttlMs: 60_000,
    });
    expect(result.success).toBe(true);
    expect(schedule).toHaveBeenCalledOnce();

    await cleanupInlineSkillWorkspace({ workspaceId: result.workspaceId! }, { cancelSchedule });
    expect(cancelSchedule).toHaveBeenCalledWith(timers[0]);
  });

  it('contains TTL cleanup failures without unhandled rejections', async () => {
    const root = await makeRoot();
    const removePath = vi.fn().mockRejectedValue(new Error('EPERM'));
    let ttlCallback: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => {
      ttlCallback = callback;
      return setTimeout(() => undefined, 60_000) as ReturnType<typeof setTimeout>;
    });

    const result = await prepareInlineSkillWorkspace(params(), {
      cacheRoot: root,
      removePath,
      schedule,
      ttlMs: 1,
    });
    expect(result.success).toBe(true);
    expect(ttlCallback).toBeTypeOf('function');

    // Fire the scheduled TTL path; the rejection must be swallowed.
    await expect(
      (async () => {
        ttlCallback!();
        // Allow the fire-and-forget promise to settle.
        await new Promise((resolve) => setImmediate(resolve));
      })(),
    ).resolves.toBeUndefined();
    expect(removePath).toHaveBeenCalled();
  });

  it.each([
    '../escape.py',
    '/tmp/escape.py',
    'scripts\\escape.py',
    'scripts/../escape.py',
    'scripts/.hidden.py',
    'scripts/ＣＯＮ',
    'scripts/CON.txt',
    'scripts/AUX.log',
    'scripts/trailing. ',
    'scripts/bad:name.txt',
    'scripts/в.txt',
    'scripts/ᲀ.txt',
    'scripts/ι.txt',
    'scripts/ͅ.txt',
    'SKILL.md',
  ])('rejects unsafe and normalization-confusable path %s', async (resourcePath) => {
    const result = await prepareInlineSkillWorkspace(params([resource(resourcePath)]), {
      cacheRoot: await makeRoot(),
    });
    expect(result).toMatchObject({ success: false });
  });

  it('rejects case-folded collisions, binary content and aggregate oversize input', async () => {
    const root = await makeRoot();
    await expect(
      prepareInlineSkillWorkspace(
        params([resource('scripts/run.py'), resource('SCRIPTS/RUN.PY')]),
        { cacheRoot: root },
      ),
    ).resolves.toMatchObject({ success: false });
    await expect(
      prepareInlineSkillWorkspace(params([resource('Strasse.txt'), resource('STRASSE.txt')]), {
        cacheRoot: root,
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      prepareInlineSkillWorkspace(params([resource('scripts'), resource('scripts/run.py')]), {
        cacheRoot: root,
      }),
    ).resolves.toMatchObject({ success: false });
    await expect(
      prepareInlineSkillWorkspace(
        params([{ ...resource('payload.bin'), mediaType: 'application/octet-stream' }]),
        {
          cacheRoot: root,
        },
      ),
    ).resolves.toMatchObject({ success: false });
    await expect(
      prepareInlineSkillWorkspace(
        params(
          Array.from({ length: 9 }, (_, index) =>
            resource(`data/${index}.txt`, 'x'.repeat(1024 * 1024)),
          ),
        ),
        { cacheRoot: root },
      ),
    ).resolves.toMatchObject({ success: false });
  });

  it('fails closed when the configured workspace root is a symlink', async () => {
    const parent = await makeRoot();
    const target = await makeRoot();
    const linkedRoot = path.join(parent, 'linked');
    await chmod(target, 0o755);
    await symlink(target, linkedRoot);

    await expect(
      prepareInlineSkillWorkspace(params(), { cacheRoot: linkedRoot }),
    ).resolves.toMatchObject({ success: false });
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
  });

  it('exports a stable content digest helper used by fixtures', () => {
    expect(hashInlineSkillContent('print("ok")')).toBe(
      createHash('sha256').update('print("ok")', 'utf8').digest('hex'),
    );
  });
});
