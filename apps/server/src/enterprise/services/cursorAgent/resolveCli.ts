import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';

import { CURSOR_AGENT_MISSING_MESSAGE, CursorAgentUnavailableError } from './errors';

/** Plain environment map: `NodeJS.ProcessEnv` is augmented with required app keys here. */
export type CursorCliEnvironment = Record<string, string | undefined>;

/** Directory containing `index.js` + bundled `node`. Overrides every other lookup. */
export const CURSOR_AGENT_HOME_ENV = 'CURSOR_AGENT_HOME';

/** Docker image location — the base stage extracts `dist-package/` here. */
export const DOCKER_CURSOR_AGENT_HOME = '/opt/cursor-agent';

const LAUNCHER_NAME = 'cursor-agent';

export type CursorCliKind = 'bundled-node' | 'launcher';

export interface CursorCliResolution {
  /** Prefix argv inserted before the CLI's own flags (`-p`, `--model`, …). */
  args: string[];
  command: string;
  kind: CursorCliKind;
}

export interface ResolveCursorCliOptions {
  /** Default `/opt/cursor-agent`. Overridable so tests do not need a real Docker tree. */
  dockerHome?: string;
  env?: CursorCliEnvironment;
  homedir?: string;
}

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isReadableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const isBundledCursorHome = (home: string): boolean =>
  isReadableFile(path.join(home, 'index.js')) && isExecutableFile(path.join(home, 'node'));

const bundledResolution = (home: string): CursorCliResolution => ({
  args: ['--use-system-ca', path.join(home, 'index.js')],
  command: path.join(home, 'node'),
  kind: 'bundled-node',
});

const lookupOnPath = (env: CursorCliEnvironment): string | undefined => {
  const pathEnv = env.PATH;
  if (!pathEnv) return undefined;

  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, LAUNCHER_NAME);
    if (isExecutableFile(candidate)) return candidate;
  }

  return undefined;
};

const lookupVersionHomes = (homedir: string): string[] => {
  const versionsRoot = path.join(homedir, '.local', 'share', 'cursor-agent', 'versions');
  let names: string[];
  try {
    names = readdirSync(versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  // Version dirs are date-prefixed (`2026.08.11-e8db854`); newest name first.
  names.sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  return names
    .map((name) => path.join(versionsRoot, name))
    .filter((home) => isBundledCursorHome(home));
};

/**
 * Resolution order: `CURSOR_AGENT_HOME` → `/opt/cursor-agent` → newest
 * `~/.local/share/cursor-agent/versions/<version>/` → `cursor-agent` on PATH.
 *
 * A set-but-invalid `CURSOR_AGENT_HOME` fails closed (no fallthrough), matching
 * the curl-impersonate env override. Throws {@link CursorAgentUnavailableError}.
 */
export const resolveCursorCli = (options: ResolveCursorCliOptions = {}): CursorCliResolution => {
  const env = options.env ?? process.env;
  const dockerHome = options.dockerHome ?? DOCKER_CURSOR_AGENT_HOME;
  const explicit = env[CURSOR_AGENT_HOME_ENV]?.trim();

  if (explicit) {
    if (isBundledCursorHome(explicit)) return bundledResolution(explicit);
    throw new CursorAgentUnavailableError(
      `Cursor Agent CLI was not found: ${CURSOR_AGENT_HOME_ENV} does not point at a directory containing index.js and node.`,
    );
  }

  if (isBundledCursorHome(dockerHome)) return bundledResolution(dockerHome);

  const versionHomes = lookupVersionHomes(options.homedir ?? osHomedir());
  if (versionHomes[0]) return bundledResolution(versionHomes[0]);

  const launcher = lookupOnPath(env);
  if (launcher) {
    return { args: [], command: launcher, kind: 'launcher' };
  }

  throw new CursorAgentUnavailableError(CURSOR_AGENT_MISSING_MESSAGE);
};

let cached: CursorCliResolution | undefined;

/** Memoized resolution — the install location cannot change while the process runs. */
export const resolveCursorCliCached = (
  options: ResolveCursorCliOptions = {},
): CursorCliResolution => {
  if (cached) return cached;
  cached = resolveCursorCli(options);
  return cached;
};

/** Test seam only. */
export const resetCursorCliCache = (): void => {
  cached = undefined;
};
