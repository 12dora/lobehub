import { sha3_512 } from '@noble/hashes/sha3.js';

import {
  bytesToBase64,
  compareBytes,
  concatBytes,
  encodeUtf8Base64,
  hexToBytes,
  randomUuid,
  utf8Encode,
} from './binary';
import {
  DEFAULT_POW_SCRIPT,
  POW_CONFIG_PREFIX,
  POW_CORES,
  POW_DOCUMENT_KEYS,
  POW_ITERATION_LIMIT,
  POW_NAVIGATOR_KEYS,
  POW_PROOF_PREFIX,
  POW_SCREEN_RESOLUTIONS,
  POW_WINDOW_KEYS,
  POW_YIELD_EVERY,
} from './constants';
import { ChatGPTWebError } from './errors';

export interface PowResources {
  dataBuild: string;
  scriptSources: string[];
}

const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+)["']/gi;
const DATA_BUILD_IN_SRC_RE = /c\/[^/]*\/_/;
const DATA_BUILD_ATTR_RE = /<html[^>]*data-build="([^"]*)"/;

/** Scrape `<script src>` values + the build marker out of the bootstrap HTML. */
export const parsePowResources = (html: string): PowResources => {
  const scriptSources: string[] = [];
  let dataBuild = '';

  for (const match of html.matchAll(SCRIPT_SRC_RE)) {
    const src = match[1];
    if (!src) continue;
    scriptSources.push(src);
    if (!dataBuild) {
      const buildMatch = DATA_BUILD_IN_SRC_RE.exec(src);
      if (buildMatch) dataBuild = buildMatch[0];
    }
  }

  if (!dataBuild) {
    const attrMatch = DATA_BUILD_ATTR_RE.exec(html);
    if (attrMatch) dataBuild = attrMatch[1];
  }

  return {
    dataBuild,
    scriptSources: scriptSources.length > 0 ? scriptSources : [DEFAULT_POW_SCRIPT],
  };
};

const pick = <T>(values: readonly T[]): T => values[Math.floor(Math.random() * values.length)];

/**
 * `new Date()` rendered the way the browser's `Date.prototype.toString` does in
 * the US/Eastern timezone — the shape the upstream sniffer expects.
 */
const legacyParseTime = (now = Date.now()): string => {
  const shifted = new Date(now - 5 * 60 * 60 * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${days[shifted.getUTCDay()]} ${months[shifted.getUTCMonth()]} ${pad(shifted.getUTCDate())} ` +
    `${shifted.getUTCFullYear()} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:` +
    `${pad(shifted.getUTCSeconds())} GMT-0500 (Eastern Standard Time)`
  );
};

/** Floats are rounded so JS and the reference implementation stringify alike. */
const round3 = (value: number) => Math.round(value * 1000) / 1000;

export type PowConfig = (string | number)[];

export interface BuildPowConfigOptions {
  dataBuild?: string;
  scriptSources?: string[];
  userAgent: string;
}

/** The 25-element browser-fingerprint array the sentinel PoW hashes. */
export const buildPowConfig = ({
  dataBuild = '',
  scriptSources,
  userAgent,
}: BuildPowConfigOptions): PowConfig => {
  const resolution = pick(POW_SCREEN_RESOLUTIONS);
  const perfNow = typeof performance === 'undefined' ? 0 : performance.now();
  const sources = scriptSources && scriptSources.length > 0 ? scriptSources : [DEFAULT_POW_SCRIPT];

  return [
    resolution[0] + resolution[1],
    legacyParseTime(),
    4_294_705_152,
    1, // overwritten with the iteration counter
    userAgent,
    pick(sources),
    dataBuild,
    'en-US',
    'en-US,es-US,en,es',
    Math.random(), // overwritten with (iteration >> 1)
    pick(POW_NAVIGATOR_KEYS),
    pick(POW_DOCUMENT_KEYS),
    pick(POW_WINDOW_KEYS),
    round3(perfNow),
    randomUuid(),
    '',
    pick(POW_CORES),
    round3(Date.now() - perfNow),
    0,
    0,
    0,
    0,
    0,
    0,
    0, // 0 = chromium, 1 = firefox
  ];
};

/**
 * `p` — the "requirements" token: the config array, no work done.
 */
export const buildLegacyRequirementsToken = (options: BuildPowConfigOptions): string =>
  POW_CONFIG_PREFIX + encodeUtf8Base64(JSON.stringify(buildPowConfig(options)));

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

export interface SolveProofTokenOptions {
  config: PowConfig;
  difficulty: string;
  /** Iteration cap (defaults to the upstream's 500 000). */
  limit?: number;
  seed: string;
  signal?: AbortSignal;
  /** Await a macrotask every N iterations so the event loop stays responsive. */
  yieldEvery?: number;
}

/**
 * Solve the sentinel proof of work.
 *
 * The comparison is a *lexicographic byte compare* of the first `difficulty/2`
 * digest bytes against the difficulty bytes — not a leading-zero count.
 */
export const solveProofToken = async ({
  config,
  difficulty,
  limit = POW_ITERATION_LIMIT,
  seed,
  signal,
  yieldEvery = POW_YIELD_EVERY,
}: SolveProofTokenOptions): Promise<string> => {
  // a sha3-512 digest is 64 bytes; anything longer cannot be a real difficulty
  const target = hexToBytes(difficulty, 64);
  const diffLen = target.length;
  const seedBytes = utf8Encode(seed);

  const static1 = `${JSON.stringify(config.slice(0, 3)).slice(0, -1)},`;
  const static2 = `,${JSON.stringify(config.slice(4, 9)).slice(1, -1)},`;
  const static3 = `,${JSON.stringify(config.slice(10)).slice(1)}`;

  for (let i = 0; i < limit; i += 1) {
    if (signal?.aborted)
      throw new ChatGPTWebError('timeout', 'proof of work aborted', { cause: signal.reason });

    const encoded = bytesToBase64(utf8Encode(static1 + i + static2 + (i >> 1) + static3));
    const digest = sha3_512(concatBytes(seedBytes, utf8Encode(encoded)));
    if (compareBytes(digest.subarray(0, diffLen), target) <= 0) return POW_PROOF_PREFIX + encoded;

    if (yieldEvery > 0 && (i + 1) % yieldEvery === 0) await yieldToEventLoop();
  }

  throw new ChatGPTWebError(
    'pow',
    `failed to solve sentinel proof of work within ${limit} iterations (difficulty=${difficulty})`,
  );
};
