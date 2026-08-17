import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';

import { CURSOR_CONVERSATION_HEADER } from '@lobechat/model-runtime';

import { buildCursorAgentChildEnv, ensureCursorAgentStateDir } from './env';
import { CursorAgentPolicyError, CursorAgentUnavailableError } from './errors';
import {
  getCachedCursorModels,
  parseCursorModelList,
  resetCursorModelsCache,
  setCachedCursorModels,
} from './models';
import { resolveCursorCliCached } from './resolveCli';
import { scrubJsonValue, scrubSecretString } from './scrub';

export { resetCursorModelsCache };

const ORIGIN_HOST = 'cursor.local';
const KILL_GRACE_MS = 3000;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_QUEUE = 16;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;
const MODELS_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTIC_CHARS = 8192;
const MAX_MODELS_STDOUT_CHARS = 1_000_000;
const MAX_ERROR_MESSAGE_CHARS = 500;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_PROMPT_CHARS = 200_000;
const MAX_HISTORY_MESSAGES = 400;
const MAX_HISTORY_TEXT_CHARS = 400_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_DECODED_BYTES = 6 * 1024 * 1024;
const MAX_MODEL_ID_CHARS = 256;
const MODEL_ID_RE = /^[a-z0-9][\w.:\-[\]=,]*$/i;
/**
 * `--new-session-id` is validated by the CLI against exactly this shape (UUIDv4,
 * bundle 2026.08.11-e8db854 `src/state/requested-session-id.ts`) and rejected with a
 * hard exit otherwise, so an ill-formed value is dropped here instead of being passed on.
 */
const UUID_V4_RE = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
/** Keep in sync with `packages/model-runtime/src/core/streams/cursor.ts`. */
const AUTH_FAILURE_RE =
  /not logged in|unauthori[sz]ed|unauthenticated|\b401\b|authentication|log in|expired token|token expired|invalid token|invalid_api_key/i;

export const CURSOR_AGENT_MAX_CONCURRENCY_ENV = 'CURSOR_AGENT_MAX_CONCURRENCY';
export const CURSOR_AGENT_MAX_QUEUE_ENV = 'CURSOR_AGENT_MAX_QUEUE';
export const CURSOR_AGENT_TURN_TIMEOUT_MS_ENV = 'CURSOR_AGENT_TURN_TIMEOUT_MS';

const FETCH_CACHE_MAX = 4;
const keyed = new Map<string, { fetch: typeof fetch; lastUsed: number }>();

export interface CursorAgentFetchOptions {
  maxConcurrency?: number;
  maxQueue?: number;
  proxyUrl?: string | null;
  queueTimeoutMs?: number;
  turnTimeoutMs?: number;
}

interface TurnImage {
  bytes: Buffer;
  mimeType: string;
}

interface TurnRequest {
  history: unknown;
  images: TurnImage[];
  model: string;
  prompt: string;
  /** Stable per-conversation chat id (UUIDv4) from the runtime, or undefined. */
  sessionId?: string;
}

interface CursorScratch {
  configDir: string;
  root: string;
}

interface TurnScratch extends CursorScratch {
  historyPath: string;
  imagePaths: string[];
}

type TransportErrorCode = 'aborted' | 'cli_exit' | 'timeout' | 'unauthorized';

class QueueTimeoutError extends Error {
  constructor() {
    super('Cursor Agent CLI queue timed out');
    this.name = 'QueueTimeoutError';
  }
}

class QueueOverloadedError extends Error {
  constructor() {
    super('Cursor Agent CLI queue is full');
    this.name = 'QueueOverloadedError';
  }
}

const createAbortError = (): DOMException =>
  new DOMException('The operation was aborted.', 'AbortError');

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const jsonError = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ error: { code, message } }), {
    headers: { 'content-type': 'application/json' },
    status,
  });

const trimErrorMessage = (text: string, token: string): string =>
  scrubSecretString(text, token).trim().slice(0, MAX_ERROR_MESSAGE_CHARS);

const looksLikeAuthFailure = (text: string): boolean => AUTH_FAILURE_RE.test(text);

const appendBounded = (store: { text: string }, chunk: string, maxChars: number): void => {
  if (store.text.length >= maxChars) return;
  store.text += chunk.slice(0, maxChars - store.text.length);
};

const appendDiagnostic = (store: { text: string }, chunk: string): void => {
  appendBounded(store, chunk, MAX_DIAGNOSTIC_CHARS);
};

const extractBearerToken = (headers: Headers): string | undefined => {
  const header = headers.get('authorization');
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  const token = match?.[1];
  if (!token) return undefined;
  for (let index = 0; index < token.length; index += 1) {
    const code = token.codePointAt(index)!;
    if (code <= 0x1f || code === 0x7f) return undefined;
  }
  return token;
};

const parseRequest = (input: RequestInfo | URL, init?: RequestInit): Request => {
  if (input instanceof Request) {
    return init ? new Request(input, init) : input;
  }
  return new Request(String(input), init);
};

const assertCursorLocal = (url: URL): void => {
  if (url.protocol !== 'https:' || url.hostname !== ORIGIN_HOST) {
    throw new CursorAgentPolicyError(`refuses ${url.protocol}//${url.hostname}`);
  }
};

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

const countStringChars = (value: unknown): number => {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value) total += countStringChars(entry);
    return total;
  }
  if (value && typeof value === 'object') {
    let total = 0;
    for (const entry of Object.values(value as Record<string, unknown>)) {
      total += countStringChars(entry);
    }
    return total;
  }
  return 0;
};

const resultErrorText = (parsed: Record<string, unknown>): string => {
  const parts: string[] = [];
  if (typeof parsed.message === 'string') parts.push(parsed.message);
  if (typeof parsed.result === 'string') parts.push(parsed.result);
  if (typeof parsed.text === 'string') parts.push(parsed.text);
  const nested = parsed.error;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    if (typeof record.message === 'string') parts.push(record.message);
  }
  return parts.join('\n');
};

const isErrorResult = (parsed: Record<string, unknown>): boolean =>
  parsed.is_error === true || parsed.subtype === 'error';

/**
 * FIFO gate. Concurrent CLI processes are capped at `limit`; waiters are capped at
 * `maxQueue` (distinct 503 `overloaded` vs `queue_timeout`).
 *
 * TODO(HANDOFF): per-user fairness cannot be enforced here — the transport has no
 * trusted user identity. Do not accept a client-supplied `userId` header. The
 * ModelRuntime seam should pass a server-authenticated user id into the fetch
 * adapter so this gate can cap per-user in-flight/queued turns. See
 * docs/enterprise/cursor-provider.md.
 */
class TurnGate {
  private active = 0;
  private readonly waiters: Array<{
    reject: (error: unknown) => void;
    resolve: () => void;
  }> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}

  acquire(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new QueueOverloadedError());
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const waiter = {
        reject: (error: unknown) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
        resolve: () => {
          if (settled) return;
          settled = true;
          resolve();
        },
      };

      const timer = setTimeout(() => {
        this.removeWaiter(waiter);
        detachAbort();
        waiter.reject(new QueueTimeoutError());
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.removeWaiter(waiter);
        waiter.reject(createAbortError());
      };
      const detachAbort = () => signal?.removeEventListener('abort', onAbort);

      const originalResolve = waiter.resolve;
      waiter.resolve = () => {
        clearTimeout(timer);
        detachAbort();
        originalResolve();
      };
      const originalReject = waiter.reject;
      waiter.reject = (error: unknown) => {
        clearTimeout(timer);
        detachAbort();
        originalReject(error);
      };

      this.waiters.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    if (this.active > 0) this.active -= 1;
  }

  private removeWaiter(waiter: { reject: (error: unknown) => void; resolve: () => void }): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }
}

const killChild = (child: ChildProcessWithoutNullStreams, graceMs = KILL_GRACE_MS): void => {
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, graceMs);
  timer.unref?.();
};

const removeScratch = (root: string | undefined): void => {
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

const seedTurnConfig = (
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

const copyTurnConfigSeedBack = (
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

const parseTurnBody = async (request: Request): Promise<TurnRequest | Response> => {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return jsonError(400, 'invalid_request', 'request body exceeds 32 MiB');
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(await request.arrayBuffer());
  } catch {
    return jsonError(400, 'invalid_request', 'request body is not JSON');
  }
  if (buf.byteLength > MAX_BODY_BYTES) {
    return jsonError(400, 'invalid_request', 'request body exceeds 32 MiB');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(buf.toString('utf8'));
  } catch {
    return jsonError(400, 'invalid_request', 'request body is not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return jsonError(400, 'invalid_request', 'request body must be an object');
  }
  const body = raw as Record<string, unknown>;
  if (
    typeof body.model !== 'string' ||
    !MODEL_ID_RE.test(body.model) ||
    body.model.length > MAX_MODEL_ID_CHARS
  ) {
    return jsonError(400, 'invalid_request', 'invalid model id');
  }
  if (typeof body.prompt !== 'string') {
    return jsonError(400, 'invalid_request', 'prompt must be a string');
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) {
    return jsonError(400, 'invalid_request', 'prompt exceeds 200000 characters');
  }
  if (
    body.history !== undefined &&
    (typeof body.history !== 'object' || body.history === null || Array.isArray(body.history))
  ) {
    return jsonError(400, 'invalid_request', 'history must be an object');
  }
  const history = body.history ?? { messages: [], replaceUserInfo: false };
  const historyRecord = history as Record<string, unknown>;
  if (historyRecord.messages !== undefined) {
    if (!Array.isArray(historyRecord.messages)) {
      return jsonError(400, 'invalid_request', 'history.messages must be an array');
    }
    if (historyRecord.messages.length > MAX_HISTORY_MESSAGES) {
      return jsonError(400, 'invalid_request', `history exceeds ${MAX_HISTORY_MESSAGES} messages`);
    }
  }
  if (countStringChars(history) > MAX_HISTORY_TEXT_CHARS) {
    return jsonError(400, 'invalid_request', 'history exceeds 400000 text characters');
  }

  const images: TurnImage[] = [];
  if (body.images !== undefined) {
    if (!Array.isArray(body.images) || body.images.length > MAX_IMAGES) {
      return jsonError(400, 'invalid_request', `images must be an array of at most ${MAX_IMAGES}`);
    }
    for (const entry of body.images) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return jsonError(400, 'invalid_request', 'each image must be an object');
      }
      const image = entry as Record<string, unknown>;
      if (typeof image.mimeType !== 'string' || !/^image\/[a-zA-Z0-9.+-]+$/.test(image.mimeType)) {
        return jsonError(400, 'invalid_request', 'invalid image mimeType');
      }
      if (typeof image.dataBase64 !== 'string') {
        return jsonError(400, 'invalid_request', 'invalid image dataBase64');
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(image.dataBase64, 'base64');
      } catch {
        return jsonError(400, 'invalid_request', 'invalid image dataBase64');
      }
      if (bytes.byteLength > MAX_IMAGE_DECODED_BYTES) {
        return jsonError(400, 'invalid_request', 'image exceeds 6 MiB');
      }
      images.push({ bytes, mimeType: image.mimeType });
    }
  }
  /**
   * Private runtime→transport header (`LobeCursorAI`), stripped here: it is never
   * exported into the child env and never reaches the CLI except as the argv value.
   */
  const requestedSessionId = request.headers.get(CURSOR_CONVERSATION_HEADER)?.trim();

  return {
    history,
    images,
    model: body.model,
    prompt: body.prompt,
    ...(requestedSessionId && UUID_V4_RE.test(requestedSessionId)
      ? { sessionId: requestedSessionId.toLowerCase() }
      : {}),
  };
};

const SCRATCH_STATE_SUBDIRS = ['data', 'config', 'projects'] as const;

const createScratchRoot = (turnsDir: string): CursorScratch => {
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

const writeTurnScratch = (turnsDir: string, turn: TurnRequest): TurnScratch => {
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

/**
 * Print-mode argv. Hidden flags (`--allowed-tools`, `--single-turn`, `--disable-*`)
 * are present in this CLI build (2026.08.11-e8db854) even though `cursor-agent --help`
 * hides them — confirmed by commander accepting them without "unknown option".
 *
 * `--exclude-workspace-context` is accepted by commander but the Agent server
 * returns `[invalid_argument] Workspace context exclusion is not allowed for this
 * user, team, or selected model` (live, 2026-08-17), so it is omitted.
 *
 * `--new-session-id <uuid>` is a hidden root option that DOES apply to `-p`
 * (verified live, 2026-08-18: the emitted `session_id` on every stream-json line
 * equals the value passed). The CLI claims the id by creating its session directory,
 * so it must be unique per config dir — which it is: every turn gets a fresh
 * `CURSOR_CONFIG_DIR`. It cannot be combined with `--resume` / `--continue`, and we
 * use neither: history is replayed through `--conversation-history-file`.
 */
export const buildTurnArgv = (turn: TurnRequest, scratch: TurnScratch): string[] => {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--mode',
    'ask',
    '--single-turn',
    '--trust',
    '--disable-indexing',
    '--disable-codebase-ref',
    '--disable-auto-update',
    '--disable-project-configs',
    '--allowed-tools',
    'update_todos_tool_call',
    '--model',
    turn.model,
    '--conversation-history-file',
    scratch.historyPath,
  ];
  if (turn.sessionId) {
    args.push('--new-session-id', turn.sessionId);
  }
  for (const path of scratch.imagePaths) {
    args.push('--image', path);
  }
  args.push('--', turn.prompt);
  return args;
};

const spawnCursor = (
  cliArgs: string[],
  options: { cwd: string; env: Record<string, string> },
): ChildProcessWithoutNullStreams => {
  const resolved = resolveCursorCliCached();
  return spawn(resolved.command, [...resolved.args, ...cliArgs], {
    cwd: options.cwd,
    // The child env is intentionally a clean allowlist, not the process env; the
    // ProcessEnv augmentation only describes what THIS process expects.
    env: options.env as NodeJS.ProcessEnv,
    stdio: 'pipe',
  });
};

const transportErrorEvent = (
  code: TransportErrorCode,
  message: string,
  exitCode?: number | null,
): string =>
  JSON.stringify({
    code,
    ...(exitCode === undefined || exitCode === null ? {} : { exitCode }),
    message,
    subtype: 'error',
    type: 'transport',
  });

const mapGateError = (error: unknown): Response | undefined => {
  if (error instanceof QueueTimeoutError) {
    return jsonError(503, 'queue_timeout', 'Cursor Agent CLI queue timed out');
  }
  if (error instanceof QueueOverloadedError) {
    return jsonError(503, 'overloaded', 'Cursor Agent CLI queue is full');
  }
  return undefined;
};

const relayCliStream = (params: {
  child: ChildProcessWithoutNullStreams;
  onFinally: () => void;
  signal?: AbortSignal;
  timeoutMs: number;
  token: string;
}): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const diagnostics = { text: '' };
  let buffer = '';
  let sawResult = false;
  let closed = false;
  let finalized = false;
  let timedOut = false;
  let aborted = false;
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const kill = () => {
    if (killTimer) return;
    try {
      params.child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    killTimer = setTimeout(() => {
      try {
        params.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  };

  let onAbort = (): void => undefined;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    params.signal?.removeEventListener('abort', onAbort);
    try {
      params.onFinally();
    } catch {
      // Scratch / gate cleanup must never throw into the stream.
    }
  };

  return new ReadableStream<Uint8Array>({
    cancel() {
      aborted = true;
      closed = true;
      kill();
      finalize();
    },
    start(controller) {
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          closed = true;
        }
      };

      const finish = (exitCode: number | null) => {
        try {
          if (!closed) {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            params.signal?.removeEventListener('abort', onAbort);
            if (!sawResult) {
              const diagnostic = trimErrorMessage(diagnostics.text, params.token);
              if (aborted) {
                send(transportErrorEvent('aborted', diagnostic || 'aborted', exitCode));
              } else if (timedOut) {
                send(transportErrorEvent('timeout', diagnostic || 'turn timed out', exitCode));
              } else if (looksLikeAuthFailure(diagnostics.text)) {
                send(transportErrorEvent('unauthorized', diagnostic || 'unauthorized', exitCode));
              } else {
                send(
                  transportErrorEvent(
                    'cli_exit',
                    diagnostic || 'CLI exited without a result',
                    exitCode,
                  ),
                );
              }
            }
            send('[DONE]');
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed / cancelled.
            }
          }
        } finally {
          if (!killTimer && (aborted || timedOut)) kill();
          finalize();
        }
      };

      const handleLine = (line: string) => {
        if (!line || closed) return;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            appendDiagnostic(diagnostics, `${line}\n`);
            return;
          }
          const record = parsed as Record<string, unknown>;
          if (record.type === 'result') {
            sawResult = true;
            if (isErrorResult(record) && looksLikeAuthFailure(resultErrorText(record))) {
              const diagnostic = trimErrorMessage(resultErrorText(record), params.token);
              send(transportErrorEvent('unauthorized', diagnostic || 'unauthorized'));
              return;
            }
          }
          send(JSON.stringify(scrubJsonValue(record, params.token)));
        } catch {
          appendDiagnostic(diagnostics, `${line}\n`);
        }
      };

      onAbort = () => {
        aborted = true;
        kill();
      };

      params.child.stdout.setEncoding('utf8');
      params.child.stderr.setEncoding('utf8');
      params.child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          handleLine(line);
          newline = buffer.indexOf('\n');
        }
      });
      params.child.stderr.on('data', (chunk: string) => {
        appendDiagnostic(diagnostics, chunk);
      });
      params.child.stdout.on('error', () => undefined);
      params.child.stderr.on('error', () => undefined);
      params.child.stdin.on('error', () => undefined);
      params.child.stdin.end();

      params.child.on('error', (error) => {
        appendDiagnostic(diagnostics, error.message);
        finish(1);
      });
      params.child.on('close', (code) => {
        if (buffer.trim()) handleLine(buffer.replace(/\r$/, ''));
        buffer = '';
        finish(code);
      });

      params.signal?.addEventListener('abort', onAbort, { once: true });
      if (params.signal?.aborted) onAbort();

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        kill();
      }, params.timeoutMs);
      timeoutTimer.unref?.();
    },
  });
};

/**
 * The caller owns the gate: it must be acquired BEFORE the scratch dir and the config
 * seed are staged, so a request that is going to be rejected as overloaded never writes
 * to the shared seed (and never copies a stale snapshot back over a fresher one).
 *
 * The models cache is re-read here because the caller checked it before waiting in the
 * queue: a concurrent turn may have filled it while this one was queued, and answering
 * from the cache is cheaper than spawning the CLI again.
 */
const runListModels = async (params: {
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs: number;
  token: string;
}): Promise<Response> => {
  const cached = getCachedCursorModels(params.token);
  if (cached) {
    return new Response(JSON.stringify({ models: cached }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnCursor(['--list-models'], { cwd: params.cwd, env: params.env });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'failed to start';
    throw new CursorAgentUnavailableError(
      `Cursor Agent CLI was not found: failed to start (${trimErrorMessage(detail, params.token)}).`,
    );
  }

  const stdout = { text: '' };
  const stderr = { text: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => appendBounded(stdout, chunk, MAX_MODELS_STDOUT_CHARS));
  child.stderr.on('data', (chunk: string) => appendDiagnostic(stderr, chunk));
  child.stdin.on('error', () => undefined);
  child.stdin.end();

  const abort = () => killChild(child);
  params.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, params.timeoutMs);
  timeout.unref?.();

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', (error) => reject(error));
      child.on('close', (exitCode) => resolve(exitCode));
    });
    if (params.signal?.aborted) throw createAbortError();
    const combined = `${stdout.text}\n${stderr.text}`;
    if (code && code !== 0) {
      const message = trimErrorMessage(combined, params.token) || `CLI exited ${code}`;
      if (looksLikeAuthFailure(combined)) return jsonError(401, 'unauthorized', message);
      return jsonError(503, 'cli_error', message);
    }
    const models = parseCursorModelList(stdout.text);
    setCachedCursorModels(params.token, models);
    return new Response(JSON.stringify({ models }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const detail = error instanceof Error ? error.message : 'CLI failed';
    return jsonError(503, 'cli_error', trimErrorMessage(detail, params.token));
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', abort);
  }
};

/**
 * fetch-compatible transport that intercepts `https://cursor.local/*` and spawns
 * the Cursor CLI. Anything else is refused (the child is invisible to the SSRF stack).
 */
export const createCursorAgentFetch = (options: CursorAgentFetchOptions = {}): typeof fetch => {
  const maxConcurrency =
    options.maxConcurrency ??
    parsePositiveInt(process.env[CURSOR_AGENT_MAX_CONCURRENCY_ENV], DEFAULT_MAX_CONCURRENCY);
  const maxQueue =
    options.maxQueue ??
    parsePositiveInt(process.env[CURSOR_AGENT_MAX_QUEUE_ENV], DEFAULT_MAX_QUEUE);
  const turnTimeoutMs =
    options.turnTimeoutMs ??
    parsePositiveInt(process.env[CURSOR_AGENT_TURN_TIMEOUT_MS_ENV], DEFAULT_TURN_TIMEOUT_MS);
  const queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const gate = new TurnGate(maxConcurrency, maxQueue);
  const proxyUrl = options.proxyUrl;

  const cursorFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = parseRequest(input, init);
    const url = new URL(request.url);
    assertCursorLocal(url);

    if (request.signal?.aborted) throw createAbortError();

    let cliReady: ReturnType<typeof resolveCursorCliCached>;
    try {
      cliReady = resolveCursorCliCached();
    } catch (error) {
      if (error instanceof CursorAgentUnavailableError) {
        return jsonError(503, 'cli_unavailable', error.message);
      }
      throw error;
    }
    void cliReady;

    const token = extractBearerToken(request.headers);
    if (!token) return jsonError(401, 'unauthorized', 'missing bearer token');

    const state = ensureCursorAgentStateDir();

    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && pathname === '/v1/models') {
      const cached = getCachedCursorModels(token);
      if (cached) {
        return new Response(JSON.stringify({ models: cached }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        });
      }

      // Admission first: a rejected request must not touch the shared config seed.
      try {
        await gate.acquire(queueTimeoutMs, request.signal);
      } catch (error) {
        const mapped = mapGateError(error);
        if (mapped) return mapped;
        throw error;
      }

      let scratch: CursorScratch | undefined;
      // Assigned by the staging step below; the handler returns early when that throws.
      let seedGeneration: CursorConfigSeedGeneration;
      try {
        scratch = createScratchRoot(state.turns);
        seedGeneration = seedTurnConfig(state.configSeed, scratch.configDir);
      } catch (error) {
        gate.release();
        removeScratch(scratch?.root);
        const detail = error instanceof Error ? error.message : 'failed to stage model files';
        return jsonError(503, 'cli_error', trimErrorMessage(detail, token));
      }

      const env = buildCursorAgentChildEnv({
        proxyUrl,
        stateDir: state.root,
        token,
        turnRoot: scratch.root,
      });
      try {
        return await runListModels({
          cwd: scratch.root,
          env,
          signal: request.signal,
          timeoutMs: Math.min(turnTimeoutMs, MODELS_TIMEOUT_MS),
          token,
        });
      } catch (error) {
        if (error instanceof CursorAgentUnavailableError) {
          return jsonError(503, 'cli_unavailable', error.message);
        }
        throw error;
      } finally {
        copyTurnConfigSeedBack(scratch.configDir, state.configSeed, seedGeneration);
        removeScratch(scratch.root);
        gate.release();
      }
    }

    if (request.method === 'POST' && pathname === '/v1/turn') {
      const parsed = await parseTurnBody(request);
      if (parsed instanceof Response) return parsed;

      try {
        await gate.acquire(queueTimeoutMs, request.signal);
      } catch (error) {
        const mapped = mapGateError(error);
        if (mapped) return mapped;
        throw error;
      }

      let scratch: TurnScratch | undefined;
      // Assigned by the staging step below; the handler returns early when that throws.
      let seedGeneration: CursorConfigSeedGeneration;
      try {
        scratch = writeTurnScratch(state.turns, parsed);
        seedGeneration = seedTurnConfig(state.configSeed, scratch.configDir);
      } catch (error) {
        gate.release();
        removeScratch(scratch?.root);
        const detail = error instanceof Error ? error.message : 'failed to stage turn files';
        return jsonError(503, 'cli_error', trimErrorMessage(detail, token));
      }

      const env = buildCursorAgentChildEnv({
        proxyUrl,
        stateDir: state.root,
        token,
        turnRoot: scratch.root,
      });

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnCursor(buildTurnArgv(parsed, scratch), { cwd: scratch.root, env });
      } catch (error) {
        gate.release();
        removeScratch(scratch.root);
        const detail = error instanceof Error ? error.message : 'failed to start';
        return jsonError(
          503,
          'cli_unavailable',
          `Cursor Agent CLI was not found: failed to start (${trimErrorMessage(detail, token)}).`,
        );
      }

      let released = false;
      const onFinally = () => {
        if (!released) {
          released = true;
          gate.release();
        }
        copyTurnConfigSeedBack(scratch.configDir, state.configSeed, seedGeneration);
        removeScratch(scratch.root);
      };

      const stream = relayCliStream({
        child,
        onFinally,
        signal: request.signal,
        timeoutMs: turnTimeoutMs,
        token,
      });
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      });
    }

    return jsonError(404, 'not_found', 'unknown Cursor Agent endpoint');
  };

  return cursorFetch as typeof fetch;
};

/**
 * Cursor Agent fetch keyed by outlet `proxyUrl` (LRU 4). CLI resolution happens
 * on the FIRST REQUEST, not at import time, so a deployment without the CLI
 * still boots and only this provider reports itself unavailable.
 */
export const getCursorAgentFetch = (proxyUrl?: string | null): typeof fetch => {
  const key = proxyUrl ?? '';
  const existing = keyed.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.fetch;
  }
  while (keyed.size >= FETCH_CACHE_MAX) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [entryKey, value] of keyed) {
      if (value.lastUsed < oldestAt) {
        oldestAt = value.lastUsed;
        oldestKey = entryKey;
      }
    }
    if (oldestKey !== undefined) keyed.delete(oldestKey);
    else break;
  }
  const impl = createCursorAgentFetch(proxyUrl ? { proxyUrl } : {});
  keyed.set(key, { fetch: impl, lastUsed: Date.now() });
  return impl;
};

/** Drop cached transports whose key is not in `keep` (empty string = no-proxy transport). */
export const evictCursorAgentFetchExcept = (keep: ReadonlySet<string>): void => {
  for (const key of keyed.keys()) {
    if (key && !keep.has(key)) keyed.delete(key);
  }
};

/** Test seam only. */
export const resetCursorAgentFetch = (): void => {
  keyed.clear();
};
