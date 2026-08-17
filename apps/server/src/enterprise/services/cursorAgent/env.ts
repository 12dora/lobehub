import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import nodePath from 'node:path';

/** Operator override for the writable state tree (shared compile cache + per-turn roots). */
export const CURSOR_AGENT_STATE_DIR_ENV = 'CURSOR_AGENT_STATE_DIR';
/** Operator override for the server-instance discriminator of the persistent HOME. */
export const CURSOR_AGENT_INSTANCE_ID_ENV = 'CURSOR_AGENT_INSTANCE_ID';

const HOME_DIR_PREFIX = 'home-';

/**
 * Directories the state tree may never BE (subdirectories are fine). The tree is
 * created, chmod'ed and written to by this service; pointing it at a filesystem root or
 * a shared system directory would put server-owned files straight into it.
 */
const FORBIDDEN_STATE_DIRS = new Set([
  '/',
  '/app',
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
]);

const DOCKER_LOBE_DIR = '/app/.lobe';
const TMP_STATE_DIR_NAME = 'aihub-cursor-agent';

const LOCALE_KEYS = new Set([
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TZ',
]);

export type CursorAgentParentEnv = Record<string, string | undefined>;

export interface CursorAgentStatePaths {
  cache: string;
  compile: string;
  configSeed: string;
  /** Persistent CLI HOME of THIS server instance (`home-<instanceId>`). */
  home: string;
  root: string;
  turns: string;
}

export interface BuildCursorAgentChildEnvOptions {
  env?: CursorAgentParentEnv;
  /** Egress proxy URL from the network-proxy hook; omitted → no proxy vars. */
  proxyUrl?: string | null;
  stateDir?: string;
  token: string;
  /**
   * Per-turn scratch root: CURSOR_DATA_DIR / CURSOR_CONFIG_DIR / CURSOR_PROJECTS_DIR
   * live inside it and are deleted with the turn, so no chat, transcript or workspace
   * path survives a turn. HOME and the compile cache (`XDG_CACHE_HOME` /
   * `NODE_COMPILE_CACHE`) stay on the persistent state dir. Required: every caller
   * stages a turn root, and a child sharing the persistent config dir would both
   * accumulate chats and collide on `--new-session-id`.
   */
  turnRoot: string;
}

const isLocaleKey = (key: string): boolean => LOCALE_KEYS.has(key) || key.startsWith('LC_');

/**
 * Refuse an operator override that is a filesystem root or a broad system directory —
 * `/var/lib/aihub/cursor-agent` is fine, `/var` is not. Raised at resolution time, so the
 * deployment fails with a clear message instead of scattering state across the host.
 */
const assertUsableStateDir = (stateDir: string): string => {
  if (FORBIDDEN_STATE_DIRS.has(stateDir))
    throw new Error(
      `${CURSOR_AGENT_STATE_DIR_ENV} must be a dedicated directory, not ${stateDir} — use a subdirectory such as ${nodePath.join(stateDir, 'aihub-cursor-agent')}`,
    );

  return stateDir;
};

/**
 * `CURSOR_AGENT_STATE_DIR` → `$LOBE_HOME/cursor-agent` or `/app/.lobe/cursor-agent`
 * when that base exists → `<tmpdir>/aihub-cursor-agent`.
 */
export const resolveCursorAgentStateDir = (env: CursorAgentParentEnv = process.env): string => {
  const explicit = env[CURSOR_AGENT_STATE_DIR_ENV]?.trim();
  if (explicit) return assertUsableStateDir(nodePath.resolve(explicit));

  const lobeHome = env.LOBE_HOME?.trim();
  if (lobeHome && existsSync(lobeHome))
    return nodePath.join(nodePath.resolve(lobeHome), 'cursor-agent');

  if (existsSync(DOCKER_LOBE_DIR)) return nodePath.join(DOCKER_LOBE_DIR, 'cursor-agent');

  return nodePath.join(tmpdir(), TMP_STATE_DIR_NAME);
};

/**
 * Server-instance discriminator for the persistent HOME.
 *
 * The CLI rewrites `$HOME/.cursor/agent-cli-state.json` and re-syncs
 * `$HOME/.cursor/skills-cursor/**` on a cold start. Multi-replica deployments are told
 * to put the state dir on one shared volume, which would have several replicas writing
 * that tree at the same time with no lock; a HOME per instance removes the race by
 * construction and still costs exactly one skills sync per replica. In Docker the
 * container id is the default hostname, so a redeploy gets a fresh HOME and the retired
 * one is left in place for the operator to remove (see {@link ensureCursorAgentStateDir}).
 */
export const resolveCursorAgentInstanceId = (env: CursorAgentParentEnv = process.env): string => {
  const candidate = env[CURSOR_AGENT_INSTANCE_ID_ENV]?.trim() || env.HOSTNAME?.trim() || hostname();
  const sanitized = (candidate || 'default').toLowerCase().replaceAll(/[^\da-z_-]+/g, '-');

  return sanitized.replaceAll(/^-+|-+$/g, '').slice(0, 40) || 'default';
};

const ensureDir = (path: string): void => {
  mkdirSync(path, { mode: 0o700, recursive: true });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort: some filesystems ignore chmod (the mode at create still applied).
  }
};

export const cursorAgentStatePaths = (
  stateDir: string,
  instanceId = resolveCursorAgentInstanceId(),
): CursorAgentStatePaths => ({
  cache: nodePath.join(stateDir, 'cache'),
  compile: nodePath.join(stateDir, 'cache', 'compile'),
  configSeed: nodePath.join(stateDir, 'config-seed'),
  home: nodePath.join(stateDir, `${HOME_DIR_PREFIX}${instanceId}`),
  root: stateDir,
  turns: nodePath.join(stateDir, 'turns'),
});

/**
 * Create the state tree at 0700 and return the resolved paths.
 *
 * Stale `home-<instanceId>` directories of retired replicas are NOT deleted here. There
 * is no safe liveness signal for a peer's HOME (a directory's mtime is not a heartbeat:
 * writes below it need not touch the root), so an automatic recursive delete could take
 * out a live replica's HOME. Removing them is a documented manual operation — see
 * docs/enterprise/cursor-provider.md.
 */
export const ensureCursorAgentStateDir = (
  env: CursorAgentParentEnv = process.env,
): CursorAgentStatePaths => {
  const paths = cursorAgentStatePaths(
    resolveCursorAgentStateDir(env),
    resolveCursorAgentInstanceId(env),
  );
  for (const path of [
    paths.root,
    paths.home,
    paths.cache,
    paths.compile,
    paths.configSeed,
    paths.turns,
  ]) {
    ensureDir(path);
  }
  return paths;
};

/**
 * Child environment from a clean base. Does NOT inherit the server process env —
 * only PATH, locale, TZ from the parent, plus the Cursor-specific overrides.
 * `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are set only when `proxyUrl` is given.
 */
export const buildCursorAgentChildEnv = (
  options: BuildCursorAgentChildEnvOptions,
): Record<string, string> => {
  const parent = options.env ?? process.env;
  const paths = cursorAgentStatePaths(
    options.stateDir ?? resolveCursorAgentStateDir(parent),
    resolveCursorAgentInstanceId(parent),
  );

  const child: Record<string, string> = {};

  if (parent.PATH) child.PATH = parent.PATH;

  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (isLocaleKey(key)) child[key] = value;
  }

  const turnRoot = options.turnRoot;
  child.HOME = paths.home;
  child.CURSOR_DATA_DIR = nodePath.join(turnRoot, 'data');
  child.CURSOR_CONFIG_DIR = nodePath.join(turnRoot, 'config');
  child.CURSOR_PROJECTS_DIR = nodePath.join(turnRoot, 'projects');
  child.XDG_CACHE_HOME = paths.cache;
  child.NODE_COMPILE_CACHE = paths.compile;
  child.AGENT_CLI_CREDENTIAL_STORE = 'memory';
  child.CURSOR_AUTH_TOKEN = options.token;
  child.NO_OPEN_BROWSER = '1';
  child.AGENT_CLI_HIDE_BANNER = '1';
  child.CURSOR_INVOKED_AS = 'cursor-agent';

  const proxyUrl = options.proxyUrl?.trim();
  if (proxyUrl) {
    child.HTTPS_PROXY = proxyUrl;
    child.HTTP_PROXY = proxyUrl;
    child.NO_PROXY = '127.0.0.1,localhost';
  }

  return child;
};
