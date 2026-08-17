// @vitest-environment node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCursorAgentChildEnv,
  CURSOR_AGENT_INSTANCE_ID_ENV,
  CURSOR_AGENT_STATE_DIR_ENV,
  ensureCursorAgentStateDir,
  resolveCursorAgentInstanceId,
  resolveCursorAgentStateDir,
} from './env';

const { join } = nodePath;

const previousStateDir = process.env[CURSOR_AGENT_STATE_DIR_ENV];
const previousInstanceId = process.env[CURSOR_AGENT_INSTANCE_ID_ENV];
const previousLobeHome = process.env.LOBE_HOME;
let root: string | undefined;

beforeEach(() => {
  process.env[CURSOR_AGENT_INSTANCE_ID_ENV] = 'replica-a';
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env[CURSOR_AGENT_STATE_DIR_ENV];
  else process.env[CURSOR_AGENT_STATE_DIR_ENV] = previousStateDir;
  if (previousInstanceId === undefined) delete process.env[CURSOR_AGENT_INSTANCE_ID_ENV];
  else process.env[CURSOR_AGENT_INSTANCE_ID_ENV] = previousInstanceId;
  if (previousLobeHome === undefined) delete process.env.LOBE_HOME;
  else process.env.LOBE_HOME = previousLobeHome;
  if (root) rmSync(root, { force: true, recursive: true });
  root = undefined;
});

describe('resolveCursorAgentStateDir', () => {
  it('prefers CURSOR_AGENT_STATE_DIR when set', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-state-'));
    const dir = join(root, 'explicit');
    expect(resolveCursorAgentStateDir({ [CURSOR_AGENT_STATE_DIR_ENV]: dir })).toBe(dir);
  });

  it('uses $LOBE_HOME/cursor-agent when that base exists', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-state-'));
    expect(resolveCursorAgentStateDir({ LOBE_HOME: root })).toBe(join(root, 'cursor-agent'));
  });

  it('falls back to <tmpdir>/aihub-cursor-agent when no base exists', () => {
    const resolved = resolveCursorAgentStateDir({
      [CURSOR_AGENT_STATE_DIR_ENV]: '',
      LOBE_HOME: '/no/such/lobe/home',
    });
    expect(resolved).toBe(join(tmpdir(), 'aihub-cursor-agent'));
  });
});

describe('resolveCursorAgentInstanceId', () => {
  it('prefers the explicit override, then HOSTNAME', () => {
    expect(
      resolveCursorAgentInstanceId({
        [CURSOR_AGENT_INSTANCE_ID_ENV]: 'Replica-01',
        HOSTNAME: 'container-abc',
      }),
    ).toBe('replica-01');
    expect(resolveCursorAgentInstanceId({ HOSTNAME: 'Container_ABC.local' })).toBe(
      'container_abc-local',
    );
  });

  it('never produces an empty or path-bearing segment', () => {
    expect(resolveCursorAgentInstanceId({ [CURSOR_AGENT_INSTANCE_ID_ENV]: '///' })).toBe('default');
    expect(
      resolveCursorAgentInstanceId({ [CURSOR_AGENT_INSTANCE_ID_ENV]: '../../etc/passwd' }),
    ).not.toContain('/');
  });
});

describe('ensureCursorAgentStateDir', () => {
  it('creates the state tree at 0700 with a HOME per server instance', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-state-'));
    const dir = join(root, 'state');
    const paths = ensureCursorAgentStateDir({
      [CURSOR_AGENT_INSTANCE_ID_ENV]: 'replica-a',
      [CURSOR_AGENT_STATE_DIR_ENV]: dir,
    });

    expect(paths.root).toBe(dir);
    expect(paths.home).toBe(join(dir, 'home-replica-a'));
    for (const path of [paths.home, paths.configSeed, paths.cache, paths.compile, paths.turns]) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o700);
    }
    // The per-turn dirs are staged by the transport, never pre-created on the shared tree.
    expect(existsSync(join(dir, 'data'))).toBe(false);
    expect(existsSync(join(dir, 'config'))).toBe(false);
    expect(existsSync(join(dir, 'projects'))).toBe(false);
  });

  it('gives another instance its own HOME and never prunes a live one', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-state-'));
    const dir = join(root, 'state');
    const a = ensureCursorAgentStateDir({
      [CURSOR_AGENT_INSTANCE_ID_ENV]: 'replica-a',
      [CURSOR_AGENT_STATE_DIR_ENV]: dir,
    });
    const b = ensureCursorAgentStateDir({
      [CURSOR_AGENT_INSTANCE_ID_ENV]: 'replica-b',
      [CURSOR_AGENT_STATE_DIR_ENV]: dir,
    });

    expect(a.home).not.toBe(b.home);
    expect(existsSync(a.home)).toBe(true);
    expect(existsSync(b.home)).toBe(true);
  });

  /**
   * A directory mtime is not a heartbeat, so an "old" HOME can belong to a replica that
   * is serving turns right now. Deleting it recursively is not worth the risk: retired
   * HOMEs are removed by the operator (documented), never automatically.
   */
  it('never deletes another replica HOME, however old it looks', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-state-'));
    const dir = join(root, 'state');
    const peer = join(dir, 'home-retired-replica');
    const peerFile = join(peer, '.cursor', 'agent-cli-state.json');
    mkdirSync(nodePath.dirname(peerFile), { recursive: true });
    writeFileSync(peerFile, '{}');
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(peer, longAgo, longAgo);

    const paths = ensureCursorAgentStateDir({
      [CURSOR_AGENT_INSTANCE_ID_ENV]: 'replica-a',
      [CURSOR_AGENT_STATE_DIR_ENV]: dir,
    });

    expect(existsSync(peerFile)).toBe(true);
    expect(existsSync(paths.home)).toBe(true);
  });
});

describe('CURSOR_AGENT_STATE_DIR refusal', () => {
  it('refuses a filesystem root or a broad system directory, and allows a subdirectory', () => {
    for (const dir of ['/', '/tmp', '/var', '/home', '/root', '/app', '/var/']) {
      expect(() => resolveCursorAgentStateDir({ [CURSOR_AGENT_STATE_DIR_ENV]: dir })).toThrow(
        /dedicated directory/,
      );
    }

    expect(
      resolveCursorAgentStateDir({ [CURSOR_AGENT_STATE_DIR_ENV]: '/var/lib/aihub/cursor' }),
    ).toBe('/var/lib/aihub/cursor');
    expect(resolveCursorAgentStateDir({ [CURSOR_AGENT_STATE_DIR_ENV]: '/tmp/aihub-cursor' })).toBe(
      '/tmp/aihub-cursor',
    );
  });
});

describe('buildCursorAgentChildEnv', () => {
  it('does not inherit the server env; sets token and isolated HOME/data dirs', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-state-'));
    const stateDir = join(root, 'state');
    const turnRoot = join(root, 'turn');
    const child = buildCursorAgentChildEnv({
      env: {
        [CURSOR_AGENT_INSTANCE_ID_ENV]: 'replica-a',
        DATABASE_URL: 'postgres://secret',
        HTTPS_PROXY: 'http://parent-proxy:8080',
        KEY_VAULTS_SECRET: 'vault',
        LANG: 'en_US.UTF-8',
        PATH: '/usr/bin',
        TZ: 'UTC',
      },
      stateDir,
      token: 'jwt-token-value',
      turnRoot,
    });

    expect(child.PATH).toBe('/usr/bin');
    expect(child.LANG).toBe('en_US.UTF-8');
    expect(child.TZ).toBe('UTC');
    expect(child.HOME).toBe(join(stateDir, 'home-replica-a'));
    expect(child.CURSOR_DATA_DIR).toBe(join(turnRoot, 'data'));
    expect(child.CURSOR_CONFIG_DIR).toBe(join(turnRoot, 'config'));
    expect(child.CURSOR_PROJECTS_DIR).toBe(join(turnRoot, 'projects'));
    expect(child.XDG_CACHE_HOME).toBe(join(stateDir, 'cache'));
    expect(child.NODE_COMPILE_CACHE).toBe(join(stateDir, 'cache', 'compile'));
    expect(child.AGENT_CLI_CREDENTIAL_STORE).toBe('memory');
    expect(child.CURSOR_AUTH_TOKEN).toBe('jwt-token-value');
    expect(child.NO_OPEN_BROWSER).toBe('1');
    expect(child.AGENT_CLI_HIDE_BANNER).toBe('1');
    expect(child.CURSOR_INVOKED_AS).toBe('cursor-agent');
    expect(child.DATABASE_URL).toBeUndefined();
    expect(child.KEY_VAULTS_SECRET).toBeUndefined();
    expect(child.HTTPS_PROXY).toBeUndefined();
    expect(child.HTTP_PROXY).toBeUndefined();
  });

  it('keeps HOME persistent while pointing data/config/projects at the per-turn root', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-state-'));
    const stateDir = join(root, 'state');
    const turnRoot = join(root, 'turn');
    const child = buildCursorAgentChildEnv({
      env: { [CURSOR_AGENT_INSTANCE_ID_ENV]: 'replica-a', PATH: '/usr/bin' },
      stateDir,
      token: 'jwt',
      turnRoot,
    });

    expect(child.HOME).toBe(join(stateDir, 'home-replica-a'));
    expect(child.CURSOR_DATA_DIR).toBe(join(turnRoot, 'data'));
    expect(child.CURSOR_CONFIG_DIR).toBe(join(turnRoot, 'config'));
    expect(child.CURSOR_PROJECTS_DIR).toBe(join(turnRoot, 'projects'));
    expect(child.XDG_CACHE_HOME).toBe(join(stateDir, 'cache'));
    expect(child.NODE_COMPILE_CACHE).toBe(join(stateDir, 'cache', 'compile'));
  });

  it('sets HTTPS_PROXY/HTTP_PROXY/NO_PROXY only when proxyUrl is given', () => {
    root = mkdtempSync(join(tmpdir(), 'cursor-state-'));
    const child = buildCursorAgentChildEnv({
      env: { PATH: '/usr/bin' },
      proxyUrl: 'http://127.0.0.1:7890',
      stateDir: join(root, 'state'),
      token: 'jwt',
      turnRoot: join(root, 'turn'),
    });

    expect(child.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(child.HTTP_PROXY).toBe('http://127.0.0.1:7890');
    expect(child.NO_PROXY).toBe('127.0.0.1,localhost');
  });
});
