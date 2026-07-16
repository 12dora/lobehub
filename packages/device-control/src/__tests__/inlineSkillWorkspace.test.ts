import { access, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupInlineSkillWorkspace, prepareInlineSkillWorkspace } from '../inlineSkillWorkspace';

const roots: string[] = [];
const checksum = 'a'.repeat(64);
const resource = (resourcePath: string, content = 'print("ok")') => ({
  checksum: 'b'.repeat(64),
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

  it.each([
    '../escape.py',
    '/tmp/escape.py',
    'scripts\\escape.py',
    'scripts/../escape.py',
    'scripts/.hidden.py',
    'scripts/ＣＯＮ',
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
      prepareInlineSkillWorkspace(
        params([{ ...resource('payload.bin'), mediaType: 'application/octet-stream' }]),
        { cacheRoot: root },
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
    await symlink(target, linkedRoot);

    await expect(
      prepareInlineSkillWorkspace(params(), { cacheRoot: linkedRoot }),
    ).resolves.toMatchObject({ success: false });
  });
});
