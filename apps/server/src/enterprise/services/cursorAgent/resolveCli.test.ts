// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CursorAgentUnavailableError } from './errors';
import {
  CURSOR_AGENT_HOME_ENV,
  resetCursorCliCache,
  resolveCursorCli,
  resolveCursorCliCached,
} from './resolveCli';

const { join } = nodePath;

let root: string;

const writeBundledHome = (home: string) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'index.js'), 'module.exports = {};\n');
  writeFileSync(join(home, 'node'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(home, 'node'), 0o755);
};

const writeLauncher = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'cursor-agent');
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
};

afterEach(() => {
  resetCursorCliCache();
  if (root) rmSync(root, { force: true, recursive: true });
});

describe('resolveCursorCli', () => {
  it('prefers CURSOR_AGENT_HOME over docker, versions, and PATH', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-cli-'));
    const home = join(root, 'explicit');
    writeBundledHome(home);
    writeBundledHome(join(root, 'docker'));
    writeBundledHome(
      join(root, 'user', '.local', 'share', 'cursor-agent', 'versions', '2026.08.11-e8db854'),
    );
    const launcher = writeLauncher(join(root, 'bin'));

    const resolved = resolveCursorCli({
      dockerHome: join(root, 'docker'),
      env: { [CURSOR_AGENT_HOME_ENV]: home, PATH: join(root, 'bin') },
      homedir: join(root, 'user'),
    });

    expect(resolved.kind).toBe('bundled-node');
    expect(resolved.command).toBe(join(home, 'node'));
    expect(resolved.args).toEqual(['--use-system-ca', join(home, 'index.js')]);
    expect(resolved.command).not.toBe(launcher);
  });

  it('rejects a CURSOR_AGENT_HOME that is not a bundled install (no fallthrough)', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-cli-'));
    writeBundledHome(join(root, 'docker'));
    writeLauncher(join(root, 'bin'));

    expect(() =>
      resolveCursorCli({
        dockerHome: join(root, 'docker'),
        env: { [CURSOR_AGENT_HOME_ENV]: join(root, 'missing'), PATH: join(root, 'bin') },
      }),
    ).toThrow(CursorAgentUnavailableError);
  });

  it('uses /opt/cursor-agent (dockerHome) before the user versions tree', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-cli-'));
    const docker = join(root, 'opt-cursor-agent');
    writeBundledHome(docker);
    writeBundledHome(
      join(root, 'user', '.local', 'share', 'cursor-agent', 'versions', '2026.08.11-e8db854'),
    );
    writeLauncher(join(root, 'bin'));

    const resolved = resolveCursorCli({
      dockerHome: docker,
      env: { PATH: join(root, 'bin') },
      homedir: join(root, 'user'),
    });

    expect(resolved.command).toBe(join(docker, 'node'));
    expect(resolved.kind).toBe('bundled-node');
  });

  it('picks the newest ~/.local/share/cursor-agent/versions/* bundled home', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-cli-'));
    const versions = join(root, 'user', '.local', 'share', 'cursor-agent', 'versions');
    writeBundledHome(join(versions, '2026.07.01-old'));
    writeBundledHome(join(versions, '2026.08.11-e8db854'));
    mkdirSync(join(versions, '.tmp-ignored'), { recursive: true });
    writeLauncher(join(root, 'bin'));

    const resolved = resolveCursorCli({
      dockerHome: join(root, 'no-docker'),
      env: { PATH: join(root, 'bin') },
      homedir: join(root, 'user'),
    });

    expect(resolved.command).toBe(join(versions, '2026.08.11-e8db854', 'node'));
    expect(resolved.args[1]).toBe(join(versions, '2026.08.11-e8db854', 'index.js'));
  });

  it('falls back to cursor-agent on PATH as a launcher', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-cli-'));
    const launcher = writeLauncher(join(root, 'bin'));

    const resolved = resolveCursorCli({
      dockerHome: join(root, 'no-docker'),
      env: { PATH: join(root, 'bin') },
      homedir: join(root, 'user'),
    });

    expect(resolved).toEqual({ args: [], command: launcher, kind: 'launcher' });
  });

  it('throws an actionable error when nothing is installed', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-cli-'));

    expect(() =>
      resolveCursorCli({
        dockerHome: join(root, 'no-docker'),
        env: {},
        homedir: join(root, 'user'),
      }),
    ).toThrow(/CURSOR_AGENT_HOME/);
  });

  it('caches the resolution until resetCursorCliCache()', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-cli-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    writeBundledHome(first);
    writeBundledHome(second);

    const a = resolveCursorCliCached({
      dockerHome: join(root, 'no-docker'),
      env: { [CURSOR_AGENT_HOME_ENV]: first },
    });
    const b = resolveCursorCliCached({
      dockerHome: join(root, 'no-docker'),
      env: { [CURSOR_AGENT_HOME_ENV]: second },
    });
    expect(b).toBe(a);
    expect(a.command).toBe(join(first, 'node'));

    resetCursorCliCache();
    const c = resolveCursorCliCached({
      dockerHome: join(root, 'no-docker'),
      env: { [CURSOR_AGENT_HOME_ENV]: second },
    });
    expect(c.command).toBe(join(second, 'node'));
  });
});
