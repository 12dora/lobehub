/**
 * Lazy koffi bindings for libcurl-impersonate.
 *
 * Load once per process. A missing library, a failed `koffi.load`, or a missing
 * exported symbol makes the persistent transport unavailable — callers fall
 * back to the CLI. Never throw at import time.
 */
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import debug from 'debug';
import type * as KoffiNs from 'koffi';

const log = debug('lobe-server:browser-session:transport');

const require = createRequire(import.meta.url);

type KoffiModule = typeof KoffiNs;

let koffiModule: KoffiModule | undefined;

/**
 * Lazy native load. A missing `@koromix/koffi-<platform>` package must not
 * throw at module evaluation — probe catches this and reports unavailable.
 */
export const loadKoffi = (): KoffiModule => {
  if (koffiModule) return koffiModule;
  try {
    koffiModule = require('koffi') as KoffiModule;
    return koffiModule;
  } catch (error) {
    throw new Error(`koffi native binding is unavailable (${(error as Error).message})`, {
      cause: error,
    });
  }
};

/** Explicit override; always wins so an operator can pin a vetted build. */
export const LIBCURL_IMPERSONATE_PATH_ENV = 'CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH';

/** Docker image location — another package extracts the shared library here. */
const DOCKER_LIBRARY_PATH = '/usr/local/lib/libcurl-impersonate.so';

/** Dev location, filled by `bun run curl-impersonate:install`. */
const REPO_CACHE_DIR = path.join('.cache', 'curl-impersonate');

const LIBRARY_NAMES = ['libcurl-impersonate.dylib', 'libcurl-impersonate.so'] as const;

/** How far up from cwd to look for the repo-local cache (monorepo package cwd). */
const REPO_LOOKUP_DEPTH = 6;

export type TransportEnvironment = Record<string, string | undefined>;

export interface ResolveLibcurlImpersonatePathOptions {
  cwd?: string;
  env?: TransportEnvironment;
  override?: string;
}

const isReadable = (path: string): boolean => {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const lookupRepoCache = (cwd: string): string | undefined => {
  let current = path.resolve(cwd);

  for (let depth = 0; depth < REPO_LOOKUP_DEPTH; depth += 1) {
    for (const name of LIBRARY_NAMES) {
      const candidate = path.join(current, REPO_CACHE_DIR, name);
      if (isReadable(candidate)) return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
};

/**
 * Resolution order: env override → repo `.cache/curl-impersonate/` → Docker path.
 * Returns undefined when nothing readable is found (never throws).
 */
export const resolveLibcurlImpersonatePath = (
  options: ResolveLibcurlImpersonatePathOptions = {},
): string | undefined => {
  const env = options.env ?? process.env;
  const explicit = options.override || env[LIBCURL_IMPERSONATE_PATH_ENV];

  if (explicit) {
    return isReadable(explicit) ? explicit : undefined;
  }

  return (
    lookupRepoCache(options.cwd ?? process.cwd()) ??
    (isReadable(DOCKER_LIBRARY_PATH) ? DOCKER_LIBRARY_PATH : undefined)
  );
};

/*
 * curl.h option encoding (this exact libcurl-impersonate release):
 *   CURLOPTTYPE_LONG          = 0
 *   CURLOPTTYPE_OBJECTPOINT   = 10000
 *   CURLOPTTYPE_FUNCTIONPOINT = 20000
 *   CURLOPTTYPE_OFF_T         = 30000
 * Numeric values below are `TYPE + id` from `CINIT(name, type, id)`.
 */
export const CURLOPT = {
  ACCEPT_ENCODING: 10_102, // OBJECTPOINT 102
  CAINFO: 10_065, // OBJECTPOINT 65
  CONNECTTIMEOUT_MS: 156, // LONG 156
  COOKIEFILE: 10_031, // OBJECTPOINT 31
  COOKIEJAR: 10_082, // OBJECTPOINT 82
  COPYPOSTFIELDS: 10_165, // OBJECTPOINT 165
  CUSTOMREQUEST: 10_036, // OBJECTPOINT 36
  FOLLOWLOCATION: 52, // LONG 52
  HEADERFUNCTION: 20_079, // FUNCTIONPOINT 79
  HTTP_VERSION: 84, // VALUES/LONG 84
  HTTPHEADER: 10_023, // SLISTPOINT 23
  NOBODY: 44, // LONG 44
  NOSIGNAL: 99, // LONG 99
  PIPEWAIT: 237, // LONG 237
  POST: 47, // LONG 47
  POSTFIELDSIZE_LARGE: 30_120, // OFF_T 120
  PROXY: 10_004, // OBJECTPOINT 4
  SUPPRESS_CONNECT_HEADERS: 265, // LONG 265
  TIMEOUT_MS: 155, // LONG 155
  URL: 10_002, // OBJECTPOINT 2
  WRITEFUNCTION: 20_011, // FUNCTIONPOINT 11
} as const;

/*
 * CURLINFO_LONG = 0x200000; CURLINFO_<name> = CURLINFO_LONG + id
 */
export const CURLINFO = {
  COOKIELIST: 0x40_001c, // SLIST + 28
  HTTP_VERSION: 0x20_002e, // LONG + 46
  LOCAL_PORT: 0x20_002a, // LONG + 42
  NUM_CONNECTS: 0x20_001a, // LONG + 26
  RESPONSE_CODE: 0x20_0002, // LONG + 2
} as const;

/** CURLMcode: CALL_MULTI_PERFORM means "call perform again", not an error. */
export const CURLM_CALL_MULTI_PERFORM = -1;
export const CURLM_OK = 0;

export const CURLMOPT_PIPELINING = 3; // LONG 3
export const CURLPIPE_MULTIPLEX = 2;

export const CURLMSG_DONE = 1;

export const CURL_HTTP_VERSION_2TLS = 4;

/** Write callback: pause receiving. libcurl redelivers the same data after unpause. */
export const CURL_WRITEFUNC_PAUSE = 0x10_000_001;
export const CURL_WRITEFUNC_ERROR = 0xff_ff_ff_ff;

export const CURLPAUSE_CONT = 0;
export const CURLPAUSE_RECV = 1;

export const CURL_GLOBAL_DEFAULT = 3; // CURL_GLOBAL_SSL | CURL_GLOBAL_WIN32

/** Connect budget matching the CLI `--connect-timeout 20`. */
export const CONNECT_TIMEOUT_MS = 20_000;

/** Multi poll ceiling. Wakeup interrupts sooner. */
export const MULTI_POLL_TIMEOUT_MS = 1000;

export const REQUIRED_SYMBOLS = [
  'curl_easy_cleanup',
  'curl_easy_getinfo',
  'curl_easy_impersonate',
  'curl_easy_init',
  'curl_easy_pause',
  'curl_easy_setopt',
  'curl_easy_strerror',
  'curl_global_init',
  'curl_multi_add_handle',
  'curl_multi_cleanup',
  'curl_multi_info_read',
  'curl_multi_init',
  'curl_multi_perform',
  'curl_multi_poll',
  'curl_multi_remove_handle',
  'curl_multi_setopt',
  'curl_multi_strerror',
  'curl_multi_wakeup',
  'curl_slist_append',
  'curl_slist_free_all',
] as const;

export interface LibcurlProbeResult {
  available: boolean;
  libraryPath?: string;
  reason?: string;
  version?: string;
}

export type KoffiPollCallback = (error: Error | null, result: number) => void;

type KoffiFunc = ((...args: unknown[]) => unknown) & {
  async: (...args: [...unknown[], KoffiPollCallback]) => void;
};

export interface LibcurlBindings {
  curl_easy_cleanup: (handle: unknown) => void;
  curl_easy_getinfo: (...args: unknown[]) => number;
  curl_easy_impersonate: (handle: unknown, target: string, defaultHeaders: number) => number;
  curl_easy_init: () => unknown;
  curl_easy_pause: (handle: unknown, bitmask: number) => number;
  curl_easy_setopt: (...args: unknown[]) => number;
  curl_easy_strerror: (code: number) => string;
  curl_global_init: (flags: number) => number;
  curl_multi_add_handle: (multi: unknown, handle: unknown) => number;
  curl_multi_cleanup: (multi: unknown) => number;
  curl_multi_info_read: (multi: unknown, queue: number[]) => unknown;
  curl_multi_init: () => unknown;
  curl_multi_perform: (multi: unknown, running: number[]) => number;
  curl_multi_poll: KoffiFunc;
  curl_multi_remove_handle: (multi: unknown, handle: unknown) => number;
  curl_multi_setopt: (...args: unknown[]) => number;
  curl_multi_strerror: (code: number) => string;
  curl_multi_wakeup: (multi: unknown) => number;
  curl_slist_append: (list: unknown, value: string) => unknown;
  curl_slist_free_all: (list: unknown) => void;
  curl_version: () => string;
  CURLMsg: unknown;
  libraryPath: string;
  WriteCb: unknown;
}

let cachedBindings: LibcurlBindings | undefined;
let cachedProbe: LibcurlProbeResult | undefined;
let typesReady = false;
let writeCbType: unknown;
let curlMsgType: unknown;

const declareOnce = (name: string, declare: () => unknown): unknown => {
  try {
    return declare();
  } catch {
    // koffi types are process-global; a test probe reset reuses them.
    return undefined;
  }
};

const ensureKoffiTypes = (): { CURLMsg: unknown; WriteCb: unknown } => {
  const koffi = loadKoffi();
  if (typesReady && writeCbType && curlMsgType) {
    return { CURLMsg: curlMsgType, WriteCb: writeCbType };
  }

  declareOnce('CURL', () => koffi.opaque('CURL'));
  declareOnce('CURLM', () => koffi.opaque('CURLM'));
  declareOnce('curl_slist', () => koffi.opaque('curl_slist'));

  writeCbType =
    declareOnce('WriteCb', () =>
      koffi.proto('size_t WriteCb(void *ptr, size_t size, size_t nmemb, void *userdata)'),
    ) ?? writeCbType;

  // Layout matches `struct CURLMsg` in multi.h: msg, easy_handle, union{result}.
  // The union is decoded as `int result` (little-endian overlay of CURLcode).
  curlMsgType =
    declareOnce('CURLMsg', () =>
      koffi.struct('CURLMsg', {
        msg: 'int',
        easy_handle: 'CURL *',
        result: 'int',
      }),
    ) ?? curlMsgType;

  if (!writeCbType || !curlMsgType) {
    throw new Error('failed to declare libcurl koffi types');
  }

  typesReady = true;
  return { CURLMsg: curlMsgType, WriteCb: writeCbType };
};

const FUNCTION_PROTOS = {
  curl_easy_cleanup: 'void curl_easy_cleanup(CURL *h)',
  curl_easy_getinfo: 'int curl_easy_getinfo(CURL *h, int info, ...)',
  curl_easy_impersonate:
    'int curl_easy_impersonate(CURL *h, const char *target, int default_headers)',
  curl_easy_init: 'CURL *curl_easy_init()',
  curl_easy_pause: 'int curl_easy_pause(CURL *h, int bitmask)',
  curl_easy_setopt: 'int curl_easy_setopt(CURL *h, int opt, ...)',
  curl_easy_strerror: 'const char *curl_easy_strerror(int code)',
  curl_global_init: 'int curl_global_init(long flags)',
  curl_multi_add_handle: 'int curl_multi_add_handle(CURLM *m, CURL *h)',
  curl_multi_cleanup: 'int curl_multi_cleanup(CURLM *m)',
  curl_multi_info_read: 'CURLMsg *curl_multi_info_read(CURLM *m, _Out_ int *msgs_in_queue)',
  curl_multi_init: 'CURLM *curl_multi_init()',
  curl_multi_perform: 'int curl_multi_perform(CURLM *m, _Out_ int *running)',
  curl_multi_poll:
    'int curl_multi_poll(CURLM *m, void *fds, unsigned int nfds, int timeout_ms, _Out_ int *numfds)',
  curl_multi_remove_handle: 'int curl_multi_remove_handle(CURLM *m, CURL *h)',
  curl_multi_setopt: 'int curl_multi_setopt(CURLM *m, int opt, ...)',
  curl_multi_strerror: 'const char *curl_multi_strerror(int code)',
  curl_multi_wakeup: 'int curl_multi_wakeup(CURLM *m)',
  curl_slist_append: 'curl_slist *curl_slist_append(curl_slist *l, const char *s)',
  curl_slist_free_all: 'void curl_slist_free_all(curl_slist *l)',
} as const satisfies Record<(typeof REQUIRED_SYMBOLS)[number], string>;

const loadFunc = (
  lib: ReturnType<KoffiModule['load']>,
  name: keyof typeof FUNCTION_PROTOS,
): KoffiFunc => {
  try {
    return lib.func(FUNCTION_PROTOS[name]) as KoffiFunc;
  } catch (error) {
    throw new Error(
      `libcurl-impersonate is missing exported symbol ${name} (${(error as Error).message})`,
      { cause: error },
    );
  }
};

const loadBindings = (libraryPath: string): LibcurlBindings => {
  const koffi = loadKoffi();
  const lib = koffi.load(libraryPath);
  const { CURLMsg, WriteCb } = ensureKoffiTypes();

  let curl_version: () => string = () => 'libcurl-impersonate';
  try {
    const fn = lib.func('const char *curl_version()') as () => string;
    curl_version = fn;
  } catch {
    // Optional; probe still succeeds without a version string.
  }

  return {
    CURLMsg,
    WriteCb,
    curl_easy_cleanup: loadFunc(lib, 'curl_easy_cleanup') as LibcurlBindings['curl_easy_cleanup'],
    curl_easy_getinfo: loadFunc(lib, 'curl_easy_getinfo') as LibcurlBindings['curl_easy_getinfo'],
    curl_easy_impersonate: loadFunc(
      lib,
      'curl_easy_impersonate',
    ) as LibcurlBindings['curl_easy_impersonate'],
    curl_easy_init: loadFunc(lib, 'curl_easy_init') as LibcurlBindings['curl_easy_init'],
    curl_easy_pause: loadFunc(lib, 'curl_easy_pause') as LibcurlBindings['curl_easy_pause'],
    curl_easy_setopt: loadFunc(lib, 'curl_easy_setopt') as LibcurlBindings['curl_easy_setopt'],
    curl_easy_strerror: loadFunc(
      lib,
      'curl_easy_strerror',
    ) as LibcurlBindings['curl_easy_strerror'],
    curl_global_init: loadFunc(lib, 'curl_global_init') as LibcurlBindings['curl_global_init'],
    curl_multi_add_handle: loadFunc(
      lib,
      'curl_multi_add_handle',
    ) as LibcurlBindings['curl_multi_add_handle'],
    curl_multi_cleanup: loadFunc(
      lib,
      'curl_multi_cleanup',
    ) as LibcurlBindings['curl_multi_cleanup'],
    curl_multi_info_read: loadFunc(
      lib,
      'curl_multi_info_read',
    ) as LibcurlBindings['curl_multi_info_read'],
    curl_multi_init: loadFunc(lib, 'curl_multi_init') as LibcurlBindings['curl_multi_init'],
    curl_multi_perform: loadFunc(
      lib,
      'curl_multi_perform',
    ) as LibcurlBindings['curl_multi_perform'],
    curl_multi_poll: loadFunc(lib, 'curl_multi_poll'),
    curl_multi_remove_handle: loadFunc(
      lib,
      'curl_multi_remove_handle',
    ) as LibcurlBindings['curl_multi_remove_handle'],
    curl_multi_setopt: loadFunc(lib, 'curl_multi_setopt') as LibcurlBindings['curl_multi_setopt'],
    curl_multi_strerror: loadFunc(
      lib,
      'curl_multi_strerror',
    ) as LibcurlBindings['curl_multi_strerror'],
    curl_multi_wakeup: loadFunc(lib, 'curl_multi_wakeup') as LibcurlBindings['curl_multi_wakeup'],
    curl_slist_append: loadFunc(lib, 'curl_slist_append') as LibcurlBindings['curl_slist_append'],
    curl_slist_free_all: loadFunc(
      lib,
      'curl_slist_free_all',
    ) as LibcurlBindings['curl_slist_free_all'],
    curl_version,
    libraryPath,
  };
};

const probeOnce = (options?: ResolveLibcurlImpersonatePathOptions): LibcurlProbeResult => {
  const env = options?.env ?? process.env;
  const explicit = options?.override || env[LIBCURL_IMPERSONATE_PATH_ENV];
  if (explicit && !isReadable(explicit)) {
    return {
      available: false,
      reason: `${LIBCURL_IMPERSONATE_PATH_ENV} does not point at a readable library`,
    };
  }

  const libraryPath = resolveLibcurlImpersonatePath(options);
  if (!libraryPath) {
    return {
      available: false,
      reason: 'libcurl-impersonate was not found',
    };
  }

  try {
    const bindings = loadBindings(libraryPath);
    const initRc = bindings.curl_global_init(CURL_GLOBAL_DEFAULT);
    if (initRc !== 0) {
      return {
        available: false,
        libraryPath,
        reason: `curl_global_init failed with code ${initRc}`,
      };
    }
    cachedBindings = bindings;
    let version: string | undefined;
    try {
      version = bindings.curl_version() || undefined;
    } catch {
      version = undefined;
    }
    log('loaded libcurl-impersonate from %s version=%s', libraryPath, version ?? 'unknown');
    return { available: true, libraryPath, version };
  } catch (error) {
    return {
      available: false,
      libraryPath,
      reason: `failed to load libcurl-impersonate (${(error as Error).message})`,
    };
  }
};

/**
 * Probe (and memoize) whether in-process libcurl-impersonate is usable.
 * Safe to call at import-adjacent time; never throws.
 */
export const probeLibcurlImpersonate = (
  options?: ResolveLibcurlImpersonatePathOptions,
): LibcurlProbeResult => {
  cachedProbe ??= probeOnce(options);
  return cachedProbe;
};

/** Bindings after a successful probe. Throws if the library is unavailable. */
export const getLibcurlBindings = (): LibcurlBindings => {
  const probe = probeLibcurlImpersonate();
  if (!probe.available || !cachedBindings) {
    throw new Error(probe.reason ?? 'libcurl-impersonate is unavailable');
  }
  return cachedBindings;
};

export const handleAddress = (handle: unknown): string => String(loadKoffi().address(handle));

export const registerWriteCallback = (
  bindings: LibcurlBindings,
  callback: (ptr: unknown, size: unknown, nmemb: unknown) => number,
): bigint => {
  const koffi = loadKoffi();
  return koffi.register(callback, koffi.pointer(bindings.WriteCb as never));
};

export const unregisterCallback = (id: bigint): void => {
  loadKoffi().unregister(id);
};

export const decodeBytes = (ptr: unknown, byteLength: number): Buffer => {
  if (byteLength <= 0) return Buffer.alloc(0);
  const koffi = loadKoffi();
  const decoded: unknown = koffi.decode(ptr, koffi.array('uint8_t', byteLength));
  return Buffer.from(decoded as Uint8Array);
};

export const decodeCurlMsg = (
  bindings: LibcurlBindings,
  msg: unknown,
): { easy_handle: unknown; msg: number; result: number } =>
  loadKoffi().decode(msg, bindings.CURLMsg as never) as {
    easy_handle: unknown;
    msg: number;
    result: number;
  };

export const isCurlmOk = (code: number): boolean =>
  code === CURLM_OK || code === CURLM_CALL_MULTI_PERFORM;

export const formatCurlmError = (bindings: LibcurlBindings, code: number): string => {
  try {
    return bindings.curl_multi_strerror(code) ?? `CURLMcode ${code}`;
  } catch {
    return `CURLMcode ${code}`;
  }
};

/**
 * Request-facing multi-loop failures. Always a TypeError with `fetch failed: `
 * and a numeric code — never a raw Error. CURLM codes use `curlm(N)`; poll-path
 * exceptions use `curl(0)`.
 */
export const fetchFailedMulti = (
  bindings: LibcurlBindings,
  source: number | unknown,
): TypeError => {
  if (typeof source === 'number') {
    return new TypeError(`fetch failed: curlm(${source}): ${formatCurlmError(bindings, source)}`);
  }
  const message = source instanceof Error ? source.message : String(source ?? 'unknown error');
  const detail = message.trim() || 'unknown error';
  return new TypeError(`fetch failed: curl(0): ${detail}`);
};

export type CookieSlistResult = { code: number; ok: false } | { lines: string[]; ok: true };

/** Alloc/decode seam so getinfo-failure tests do not need a native koffi addon. */
export interface CookieSlistKoffi {
  alloc: (type: string, length: number) => unknown;
  decode: (value: unknown, type: unknown) => unknown;
  struct: (fields: Record<string, string>) => unknown;
}

/** Walk a `curl_slist*` of Netscape cookie lines from CURLINFO_COOKIELIST. */
export const readCookieSlist = (
  bindings: LibcurlBindings,
  handle: unknown,
  koffi: CookieSlistKoffi = loadKoffi() as CookieSlistKoffi,
): CookieSlistResult => {
  const slot = koffi.alloc('void *', 1);
  const rc = bindings.curl_easy_getinfo(handle, CURLINFO.COOKIELIST, 'void **', slot);
  if (rc !== 0) return { code: rc, ok: false };
  let node: unknown = koffi.decode(slot, 'void *');
  if (!node) return { lines: [], ok: true };
  const layout = koffi.struct({
    data: 'char *',
    next: 'void *',
  });
  const lines: string[] = [];
  try {
    while (node) {
      const decoded = koffi.decode(node, layout) as { data: string | null; next: unknown };
      if (decoded.data) lines.push(decoded.data);
      node = decoded.next;
    }
  } finally {
    bindings.curl_slist_free_all(koffi.decode(slot, 'void *'));
  }
  return { lines, ok: true };
};

export const setoptLong = (
  bindings: LibcurlBindings,
  handle: unknown,
  option: number,
  value: number,
): number => bindings.curl_easy_setopt(handle, option, 'long', value);

export const setoptOffT = (
  bindings: LibcurlBindings,
  handle: unknown,
  option: number,
  value: number | bigint,
): number => bindings.curl_easy_setopt(handle, option, 'int64_t', value);

export const setoptString = (
  bindings: LibcurlBindings,
  handle: unknown,
  option: number,
  value: string,
): number => bindings.curl_easy_setopt(handle, option, 'str', value);

export const setoptPointer = (
  bindings: LibcurlBindings,
  handle: unknown,
  option: number,
  value: unknown,
): number => bindings.curl_easy_setopt(handle, option, 'void *', value);

export const getinfoLong = (bindings: LibcurlBindings, handle: unknown, info: number): number => {
  const koffi = loadKoffi();
  const slot = koffi.alloc('long', 1);
  const rc = bindings.curl_easy_getinfo(handle, info, 'long *', slot);
  if (rc !== 0) throw new Error(`curl_easy_getinfo failed with code ${rc}`);
  return Number(koffi.decode(slot, 'long'));
};

export const toByteCount = (size: unknown, nmemb: unknown): number => Number(size) * Number(nmemb);

/** Test seam: drop the memoized probe/bindings so a later probe re-runs. */
export const resetLibcurlImpersonateProbeForTests = (): void => {
  cachedBindings = undefined;
  cachedProbe = undefined;
};
