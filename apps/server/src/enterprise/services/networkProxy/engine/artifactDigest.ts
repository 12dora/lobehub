import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

import type { AcceptedDigestLookup } from './artifactAcceptedDigest';
import { isAcceptableDigest } from './artifactAcceptedDigest';
import { NETWORK_PROXY_ENGINE_ERROR_CODES, throwNetworkProxyError } from './errors';

interface FileIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
  path: string;
  size: number;
}

interface DigestCacheEntry {
  digest: string;
  identity: FileIdentity;
}

const digestCache = new Map<string, DigestCacheEntry>();
let afterReverifyHook: (() => void | Promise<void>) | null = null;
let spawnDigestVerifyCount = 0;
let digestHashCount = 0;

export const getSpawnDigestVerifyCount = (): number => spawnDigestVerifyCount;
export const getDigestHashCount = (): number => digestHashCount;

export const resetDigestCachesForTest = (): void => {
  afterReverifyHook = null;
  digestCache.clear();
  digestHashCount = 0;
  spawnDigestVerifyCount = 0;
};

const identityOf = (
  path: string,
  stat: { dev: number; ino: bigint | number; mtimeMs: number; size: number },
): FileIdentity => ({
  dev: Number(stat.dev),
  ino: Number(stat.ino),
  mtimeMs: Number(stat.mtimeMs),
  path,
  size: Number(stat.size),
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.path === right.path &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs;

const hashNoFollow = async (path: string): Promise<{ digest: string; identity: FileIdentity }> => {
  digestHashCount += 1;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('artifact is not a regular file');
    const hash = createHash('sha256');
    await pipeline(handle.createReadStream(), hash);
    return { digest: hash.digest('hex'), identity: identityOf(path, stat) };
  } finally {
    await handle.close();
  }
};

export const verifyPinnedFile = async (
  path: string,
  expectedSha256: string,
  opts?: {
    /** Identifies the artifact so an operator-accepted digest marker can be honoured. */
    accept?: AcceptedDigestLookup;
    reverify?: boolean;
  },
): Promise<{
  digest: string;
  identity: FileIdentity;
  pinnedDigestMatch: boolean;
  /** Real version of an accepted mismatch (from its marker); null for a pinned match. */
  reportedVersion: string | null;
}> => {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
  }
  const identity = identityOf(path, stat);
  const cached = digestCache.get(path);
  if (!opts?.reverify && cached && sameIdentity(cached.identity, identity)) {
    const verdict = await isAcceptableDigest(path, cached.digest, expectedSha256, opts?.accept);
    if (!verdict.ok) {
      digestCache.delete(path);
      return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
    }
    return {
      digest: cached.digest,
      identity,
      pinnedDigestMatch: verdict.matched,
      reportedVersion: verdict.reportedVersion,
    };
  }
  if (opts?.reverify) spawnDigestVerifyCount += 1;
  const hashed = await hashNoFollow(path);
  const verdict = await isAcceptableDigest(path, hashed.digest, expectedSha256, opts?.accept);
  if (!verdict.ok) {
    digestCache.delete(path);
    return throwNetworkProxyError(NETWORK_PROXY_ENGINE_ERROR_CODES.ARTIFACT_MISMATCH);
  }
  digestCache.set(path, { digest: hashed.digest, identity: hashed.identity });
  if (opts?.reverify) await afterReverifyHook?.();
  return {
    ...hashed,
    pinnedDigestMatch: verdict.matched,
    reportedVersion: verdict.reportedVersion,
  };
};

/** Test seam: run after a successful forced re-verify (used to mutate the file between spawn attempts). */
export const setAfterReverifyForTest = (hook: (() => void | Promise<void>) | null): void => {
  afterReverifyHook = hook;
};

export const rememberPinnedDigest = async (path: string, digest: string): Promise<void> => {
  const stat = await lstat(path);
  if (stat.isFile() && !stat.isSymbolicLink()) {
    digestCache.set(path, { digest, identity: identityOf(path, stat) });
  }
};
