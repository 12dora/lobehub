import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex, utf8Encode } from './binary';
import type { UploadedFileRef } from './types';

/**
 * Every ChatGPT Web turn replays the whole history, so the same image is
 * attached again on every follow-up message. File ids are account-scoped and
 * stable, so we upload each distinct blob once and re-reference it afterwards.
 *
 * Module-level on purpose (the runtime instance is per-request), bounded in both
 * size and age so a long-lived server process cannot grow unbounded.
 */
const MAX_ENTRIES = 200;
const TTL_MS = 24 * 60 * 60 * 1000;
/** File names come from user metadata; a 4 MB "name" must not be retained. */
const MAX_STRING_LENGTH = 128;
/** Rough retained-character ceiling for the whole cache. */
const MAX_TOTAL_WEIGHT = 64 * 1024;

interface CacheEntry {
  createdAt: number;
  ref: UploadedFileRef;
  /** approximate retained characters, so the bound is on BYTES, not entries */
  weight: number;
}

const cache = new Map<string, CacheEntry>();
let totalWeight = 0;

const cap = (value: string | undefined): string =>
  typeof value === 'string' ? value.slice(0, MAX_STRING_LENGTH) : '';

/**
 * An explicit projection, not a spread: the cache is process-wide and long
 * lived, so it stores exactly the fields the attachment builder reads — capped —
 * and drops anything else a caller happens to hang off the ref.
 */
const compactRef = (ref: UploadedFileRef): UploadedFileRef => ({
  fileId: cap(ref.fileId),
  fileTokenSize: ref.fileTokenSize,
  height: ref.height,
  kind: ref.kind,
  libraryFileId: ref.libraryFileId === undefined ? undefined : cap(ref.libraryFileId),
  mimeType: cap(ref.mimeType),
  name: cap(ref.name),
  size: ref.size,
  width: ref.width,
});

const weigh = (key: string, ref: UploadedFileRef): number =>
  key.length +
  ref.fileId.length +
  ref.mimeType.length +
  ref.name.length +
  (ref.libraryFileId?.length ?? 0) +
  // fixed overhead for the numeric fields and the Map entry itself
  64;

const drop = (key: string): void => {
  const entry = cache.get(key);
  if (!entry) return;
  totalWeight -= entry.weight;
  cache.delete(key);
};

/**
 * The namespace a runtime caches under. `chatgptAccountId` when the server knows
 * it, otherwise a digest of the access token — which is itself account-unique.
 *
 * There is deliberately NO shared fallback: file ids are account-scoped, so a
 * single `anonymous` namespace would hand one account's file reference to
 * another. Callers with neither input get `undefined` and simply do not cache.
 */
export const uploadNamespace = (
  accountId: string | undefined,
  accessToken: string | undefined,
): string | undefined => {
  if (accountId) return `acc:${accountId}`;
  if (!accessToken) return undefined;
  return `tok:${bytesToHex(sha256(utf8Encode(accessToken))).slice(0, 32)}`;
};

/** `${namespace}:${sha256(bytes)}` — never keyed across accounts. */
export const uploadCacheKey = (
  namespace: string | undefined,
  bytes: Uint8Array,
): string | undefined => (namespace ? `${namespace}:${bytesToHex(sha256(bytes))}` : undefined);

export const getCachedUpload = (
  key: string | undefined,
  now = Date.now(),
): UploadedFileRef | undefined => {
  if (!key) return undefined;
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (now - entry.createdAt > TTL_MS) {
    drop(key);
    return undefined;
  }

  // refresh recency (Map preserves insertion order → re-insert to move to the end)
  cache.delete(key);
  cache.set(key, entry);
  return entry.ref;
};

export const setCachedUpload = (
  key: string | undefined,
  ref: UploadedFileRef,
  now = Date.now(),
): void => {
  if (!key) return;
  drop(key);

  const compact = compactRef(ref);
  const weight = weigh(key, compact);
  cache.set(key, { createdAt: now, ref: compact, weight });
  totalWeight += weight;

  while (cache.size > MAX_ENTRIES || (totalWeight > MAX_TOTAL_WEIGHT && cache.size > 1)) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
};

/** Test seam. */
export const clearUploadCache = (): void => {
  cache.clear();
  totalWeight = 0;
};

/** Test seam: the approximate retained size the cache is bounded by. */
export const uploadCacheWeight = (): number => totalWeight;
