import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';

import type { TurnRequest } from './transport.parseTurn';

export interface CursorScratch {
  configDir: string;
  root: string;
}

export interface TurnScratch extends CursorScratch {
  historyPath: string;
  imagePaths: string[];
}

const IMAGE_EXT: Record<string, string> = {
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const imageExtension = (mimeType: string): string => {
  const known = IMAGE_EXT[mimeType.toLowerCase()];
  if (known) return known;
  const subtype = mimeType.split('/')[1]?.replaceAll(/[^a-z0-9]+/gi, '') ?? '';
  return subtype.slice(0, 8) || 'bin';
};

export const removeScratch = (root: string | undefined): void => {
  if (!root) return;
  try {
    fs.rmSync(root, { force: true, recursive: true });
  } catch {
    // Best effort.
  }
};

const CONFIG_SEED_FILES = ['cli-config.json', 'statsig-cache.json'] as const;
const CLI_CONFIG_FILE = CONFIG_SEED_FILES[0];
const STATSIG_CACHE_FILE = CONFIG_SEED_FILES[1];

const safeErrorClass = (error: unknown): string =>
  error instanceof Error ? error.name || 'Error' : typeof error;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Applied ONLY when a config is created from nothing (first run, no persistent seed).
 * Ghost mode is the state this deployment wants a fresh installation to start in; once
 * the CLI or the server has written a value it is theirs, and rewriting it on every
 * turn would report a privacy state the account may not actually be in.
 */
const withGhostModePinned = (value: unknown): Record<string, unknown> => {
  const config = isRecord(value) ? { ...value } : {};
  const privacyCache = isRecord(config.privacyCache) ? { ...config.privacyCache } : {};
  privacyCache.ghostMode = true;
  config.privacyCache = privacyCache;
  return config;
};

/**
 * Keys the persistent seed exists FOR. If the seed has one and the turn's copy does
 * not, the turn file is degraded (the CLI was killed mid-write on a timeout / abort —
 * the finalizer runs on those paths too) and writing it back would replace a warm seed
 * with one that forces the next turn through the cold bootstrap this seed prevents.
 */
const REQUIRED_SEED_KEYS = ['authInfo', 'version'] as const;

/**
 * Presence is not enough: a key whose VALUE is unusable leaves the seed as cold as a
 * missing key would. `authInfo` must be a non-empty object (the CLI writes a signed-out
 * state as `null` / `{}` / a bare string) and `version` a non-empty string or number.
 * Field types inside `authInfo` are deliberately NOT constrained — they belong to the
 * CLI, and guessing them would reject a config that works.
 */
const hasUsableSeedValue = (config: Record<string, unknown>, key: string): boolean => {
  const value = config[key];
  if (key === 'version')
    return (
      (typeof value === 'string' && value.length > 0) ||
      (typeof value === 'number' && Number.isFinite(value))
    );
  if (key === 'authInfo') return isRecord(value) && Object.keys(value).length > 0;

  return value !== undefined && value !== null;
};

const isSeedCopyBackAcceptable = (
  next: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
): boolean =>
  !previous ||
  REQUIRED_SEED_KEYS.every((key) => !(key in previous) || hasUsableSeedValue(next, key));

const readJsonRecord = (path: string): Record<string, unknown> | undefined => {
  if (!fs.existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path, 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    console.error('Cursor Agent config seed JSON ignored:', safeErrorClass(error));
    return undefined;
  }
};

const writeFileAtomic = (target: string, data: string | Buffer, mode = 0o600): void => {
  fs.mkdirSync(nodePath.dirname(target), { mode: 0o700, recursive: true });
  const temp = nodePath.join(
    nodePath.dirname(target),
    `.${nodePath.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temp, data, { mode });
    try {
      fs.chmodSync(temp, mode);
    } catch {
      // Best effort against umask.
    }
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Best effort.
    }
    throw error;
  }
};

const writeCliConfigAtomic = (target: string, config: Record<string, unknown>): void => {
  writeFileAtomic(target, `${JSON.stringify(config)}\n`);
};

/**
 * The seed generation a turn was staged FROM: sha256 of each seed file at read time
 * (`undefined` = the file did not exist). Copy-back compares it with the seed on disk
 * and skips the file when it changed, so a turn can only ever overwrite the exact
 * generation it started from — a compare-and-swap with no lock file to leak.
 */
export type CursorConfigSeedGeneration = Record<string, string | undefined>;

const fileDigest = (path: string): string | undefined => {
  try {
    return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  } catch {
    // Missing or unreadable: both mean "no generation to preserve".
    return undefined;
  }
};

const readSeedGeneration = (configSeedDir: string): CursorConfigSeedGeneration =>
  Object.fromEntries(
    CONFIG_SEED_FILES.map((file) => [file, fileDigest(nodePath.join(configSeedDir, file))]),
  );

export const seedTurnConfig = (
  configSeedDir: string,
  turnConfigDir: string,
): CursorConfigSeedGeneration => {
  fs.mkdirSync(turnConfigDir, { mode: 0o700, recursive: true });
  try {
    fs.chmodSync(turnConfigDir, 0o700);
  } catch {
    // Best effort against umask.
  }

  const generation = readSeedGeneration(configSeedDir);

  const cliConfigSeed = nodePath.join(configSeedDir, CLI_CONFIG_FILE);
  const seeded = readJsonRecord(cliConfigSeed);
  // A fresh installation starts in ghost mode; an existing seed is passed through as is.
  writeCliConfigAtomic(
    nodePath.join(turnConfigDir, CLI_CONFIG_FILE),
    seeded ?? withGhostModePinned({}),
  );

  const statsigSeed = nodePath.join(configSeedDir, STATSIG_CACHE_FILE);
  if (fs.existsSync(statsigSeed)) {
    writeFileAtomic(nodePath.join(turnConfigDir, STATSIG_CACHE_FILE), fs.readFileSync(statsigSeed));
  }

  return generation;
};

/**
 * `true` when nobody else replaced this seed file since the turn was staged from it.
 *
 * Compare-then-rename, not an atomic CAS: two turns can both read the same digest before
 * either rename lands, and the later rename then wins. The window is tolerated on purpose —
 * these are warm CLI cache files (config defaults + statsig snapshot), a lost update costs
 * one cold turn and nothing else, so an inter-process lock on every turn is not worth it.
 */
const seedGenerationUnchanged = (
  configSeedDir: string,
  file: string,
  generation: CursorConfigSeedGeneration,
): boolean => fileDigest(nodePath.join(configSeedDir, file)) === generation[file];

export const copyTurnConfigSeedBack = (
  turnConfigDir: string,
  configSeedDir: string,
  generation: CursorConfigSeedGeneration,
): void => {
  try {
    const cliConfig = nodePath.join(turnConfigDir, CLI_CONFIG_FILE);
    if (fs.existsSync(cliConfig)) {
      const seedPath = nodePath.join(configSeedDir, CLI_CONFIG_FILE);
      const next = readJsonRecord(cliConfig);
      // Never replace a good seed with a degraded one, and never with a stale one: a
      // concurrent turn that already wrote its result wins, this one simply skips.
      if (
        next &&
        isSeedCopyBackAcceptable(next, readJsonRecord(seedPath)) &&
        seedGenerationUnchanged(configSeedDir, CLI_CONFIG_FILE, generation)
      ) {
        writeCliConfigAtomic(seedPath, next);
      }
    }

    const statsig = nodePath.join(turnConfigDir, STATSIG_CACHE_FILE);
    // A truncated / half-written cache must never replace the warm seed either: it is
    // parsed and required to be a JSON object before it is allowed near the seed.
    if (
      fs.existsSync(statsig) &&
      readJsonRecord(statsig) &&
      seedGenerationUnchanged(configSeedDir, STATSIG_CACHE_FILE, generation)
    ) {
      writeFileAtomic(nodePath.join(configSeedDir, STATSIG_CACHE_FILE), fs.readFileSync(statsig));
    }
  } catch (error) {
    console.error('Cursor Agent config seed copy-back failed:', safeErrorClass(error));
    // Best effort: the compare-and-swap above is what keeps a concurrent turn's result.
  }
};

const SCRATCH_STATE_SUBDIRS = ['data', 'config', 'projects'] as const;

export const createScratchRoot = (turnsDir: string): CursorScratch => {
  const root = nodePath.join(turnsDir, randomUUID());
  try {
    fs.mkdirSync(root, { mode: 0o700, recursive: true });
    try {
      fs.chmodSync(root, 0o700);
    } catch {
      // Best effort against umask.
    }
    for (const sub of SCRATCH_STATE_SUBDIRS) {
      const path = nodePath.join(root, sub);
      fs.mkdirSync(path, { mode: 0o700, recursive: true });
      try {
        fs.chmodSync(path, 0o700);
      } catch {
        // Best effort against umask.
      }
    }
    return { configDir: nodePath.join(root, 'config'), root };
  } catch (error) {
    removeScratch(root);
    throw error;
  }
};

export const writeTurnScratch = (turnsDir: string, turn: TurnRequest): TurnScratch => {
  const scratch = createScratchRoot(turnsDir);
  try {
    const historyPath = nodePath.join(scratch.root, 'history.json');
    fs.writeFileSync(historyPath, `${JSON.stringify(turn.history)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(historyPath, 0o600);
    } catch {
      // Best effort against umask.
    }
    const imagePaths: string[] = [];
    turn.images.forEach((image, index) => {
      const ext = imageExtension(image.mimeType);
      const path = nodePath.join(scratch.root, `img-${index}.${ext}`);
      fs.writeFileSync(path, image.bytes, { mode: 0o600 });
      try {
        fs.chmodSync(path, 0o600);
      } catch {
        // Best effort against umask.
      }
      imagePaths.push(path);
    });
    return { ...scratch, historyPath, imagePaths };
  } catch (error) {
    removeScratch(scratch.root);
    throw error;
  }
};
