import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import pathModule from 'node:path';

import { checksumPayload } from '@/database/models/platform';

import type { PlatformSecretService } from '../../security/secret';

const LKG_DOMAIN = 'platform-oidc-lkg';
const LKG_FORMAT = 'aihub.platform.oidc-lkg';
const REVOCATION_JOURNAL_DOMAIN = 'platform-oidc-revocation-journal';
const REVOCATION_JOURNAL_FORMAT = 'aihub.platform.oidc-revocation-journal';
/** Legacy on-disk snapshot (six payload fields, no providerTombstones). Still readable. */
export const IDENTITY_PROVIDER_LKG_VERSION_V1 = 1;
/**
 * Current write version. Adds optional-on-read `providerTombstones[]` for concurrent-disable
 * merge and stale-tombstone protection. Writers always emit this version; readers still accept
 * v1 six-field snapshots (missing tombstones → []).
 */
export const IDENTITY_PROVIDER_LKG_VERSION = 2;
const LKG_WRITE_VERSION = IDENTITY_PROVIDER_LKG_VERSION;
const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const EMPTY_GENERATION = '0000-01-01T00:00:00.000Z:';
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export type IdentityProviderLkgVersion =
  typeof IDENTITY_PROVIDER_LKG_VERSION_V1 | typeof IDENTITY_PROVIDER_LKG_VERSION;

export interface IdentityProviderLkgProvider {
  checksum: string;
  generation: string;
  payload: Record<string, unknown>;
  providerId: string;
  revision: number;
  secretCiphertext: string;
  secretFingerprint: string;
}

/** Per-provider revoke memory so concurrent disables merge and stale tombstones cannot revive. */
export interface IdentityProviderLkgProviderTombstone {
  generation: string;
  providerId: string;
}

export interface IdentityProviderLkgPayload {
  createdAt: string;
  domain: typeof LKG_DOMAIN;
  generation: string;
  identityRevision: string;
  providers: IdentityProviderLkgProvider[];
  /**
   * Highest tombstone generation observed per providerId.
   * - v1 on-disk: field absent (reader defaults to [])
   * - v2 writes: always present (may be empty)
   */
  providerTombstones?: IdentityProviderLkgProviderTombstone[];
  version: IdentityProviderLkgVersion;
}

interface IdentityProviderLkgEnvelope {
  ciphertext: string;
  format: typeof LKG_FORMAT;
  signature: string;
  version: IdentityProviderLkgVersion;
}

interface IdentityProviderRevocationJournalEnvelope {
  ciphertext: string;
  format: typeof REVOCATION_JOURNAL_FORMAT;
  signature: string;
  version: 1;
}

export interface IdentityProviderRevocationJournalEntry {
  /** Absent until the database tombstone commits; pending entries always fail closed. */
  generation?: string;
  providerId: string;
  token: string;
}

interface IdentityProviderRevocationJournalPayload {
  entries: IdentityProviderRevocationJournalEntry[];
  updatedAt: string;
  version: 1;
}

export interface IdentityProviderLkgTestHooks {
  afterFileStat?: (path: string) => Promise<void>;
  beforeRename?: (path: string) => Promise<void>;
}

type OpenHandle = Awaited<ReturnType<typeof open>>;
type FileStat = Awaited<ReturnType<OpenHandle['stat']>>;

export type IdentityProviderLkgWriteResult = 'rejected' | 'unchanged' | 'written';

export type IdentityProviderLkgAdvanceSkipReason =
  | 'generation_overflow'
  | 'missing_input'
  | 'no_lkg'
  | 'read_failed'
  | 'stale_tombstone'
  | 'write_failed';

export type IdentityProviderLkgAdvanceResult =
  | IdentityProviderLkgWriteResult
  | { outcome: 'skipped'; reason: IdentityProviderLkgAdvanceSkipReason };

export class IdentityProviderLkgError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'IdentityProviderLkgError';
  }
}

export const identityProviderLkgIdentity = (
  providers: Pick<
    IdentityProviderLkgProvider,
    'checksum' | 'generation' | 'payload' | 'providerId' | 'revision' | 'secretFingerprint'
  >[],
): string =>
  checksumPayload(
    providers
      .map((provider) => ({
        checksum: provider.checksum,
        generation: provider.generation,
        providerId: provider.providerId,
        providerKey: provider.payload.providerKey,
        revision: provider.revision,
        secretFingerprint: provider.secretFingerprint,
      }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId)),
  );

export const identityProviderLkgGeneration = (
  providers: Pick<IdentityProviderLkgProvider, 'generation'>[],
): string =>
  providers.reduce(
    (latest, provider) => (provider.generation > latest ? provider.generation : latest),
    EMPTY_GENERATION,
  );

const resolveLkgPath = (env: Record<string, string | undefined>): string => {
  const configured = env.PLATFORM_OIDC_LKG_PATH?.trim();
  if (!configured) return pathModule.join(process.cwd(), '.lobe', 'platform-oidc-lkg.v1.json');
  if (!pathModule.isAbsolute(configured) || pathModule.normalize(configured) !== configured) {
    throw new IdentityProviderLkgError('OIDC_LKG_PATH_INVALID');
  }
  return configured;
};

const resolveRevocationJournalPath = (env: Record<string, string | undefined>): string =>
  `${resolveLkgPath(env)}.revocations`;

const assertSecureDirectory = async (directory: string, create: boolean): Promise<void> => {
  if (create) await mkdir(directory, { mode: 0o700, recursive: true });
  const canonical = await realpath(directory);
  if (canonical !== pathModule.normalize(directory)) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_SYMLINK_FORBIDDEN');
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_INVALID');
  }
  if ((Number(stat.mode) & 0o777) !== 0o700) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_PERMISSIONS_INVALID');
  }
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new IdentityProviderLkgError('OIDC_LKG_DIRECTORY_OWNER_INVALID');
  }
};

const assertSecureFile = (stat: FileStat): void => {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_INVALID');
  }
  if (Number(stat.nlink) !== 1) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_LINK_INVALID');
  }
  if ((Number(stat.mode) & 0o777) !== 0o600) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_PERMISSIONS_INVALID');
  }
  if (typeof process.getuid === 'function' && Number(stat.uid) !== process.getuid()) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_OWNER_INVALID');
  }
  if (Number(stat.size) <= 0 || Number(stat.size) > MAX_FILE_BYTES) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_SIZE_INVALID');
  }
};

const sameFile = (before: FileStat, after: FileStat): boolean =>
  Number(before.dev) === Number(after.dev) &&
  Number(before.ino) === Number(after.ino) &&
  Number(before.mode) === Number(after.mode) &&
  Number(before.nlink) === Number(after.nlink) &&
  Number(before.size) === Number(after.size) &&
  Number(before.uid) === Number(after.uid);

const readBoundedHandle = async (handle: OpenHandle, afterStat?: () => Promise<void>) => {
  const before = await handle.stat();
  assertSecureFile(before);
  await afterStat?.();
  const expected = Number(before.size);
  const buffer = Buffer.alloc(expected + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat();
  if (offset !== expected || !sameFile(before, after)) {
    throw new IdentityProviderLkgError('OIDC_LKG_FILE_CHANGED_DURING_READ');
  }
  return buffer.subarray(0, expected).toString('utf8');
};

const openAndReadSecure = async (path: string, afterStat?: (path: string) => Promise<void>) => {
  const handle = await open(
    /* turbopackIgnore: true */ path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    return await readBoundedHandle(handle, () => afterStat?.(path) ?? Promise.resolve());
  } finally {
    await handle.close();
  }
};

const isSupportedLkgVersion = (value: unknown): value is IdentityProviderLkgVersion =>
  value === IDENTITY_PROVIDER_LKG_VERSION_V1 || value === IDENTITY_PROVIDER_LKG_VERSION;

const parseEnvelope = (value: unknown): IdentityProviderLkgEnvelope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_LKG_ENVELOPE_INVALID');
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 4 ||
    envelope.format !== LKG_FORMAT ||
    !isSupportedLkgVersion(envelope.version) ||
    typeof envelope.ciphertext !== 'string' ||
    typeof envelope.signature !== 'string'
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_ENVELOPE_INVALID');
  }
  return envelope as unknown as IdentityProviderLkgEnvelope;
};

const parseProvider = (value: unknown): IdentityProviderLkgProvider => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_LKG_PROVIDER_INVALID');
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 7 ||
    typeof row.checksum !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.checksum) ||
    typeof row.generation !== 'string' ||
    row.generation.length === 0 ||
    row.generation.length > 512 ||
    !row.payload ||
    typeof row.payload !== 'object' ||
    Array.isArray(row.payload) ||
    typeof row.providerId !== 'string' ||
    row.providerId.length === 0 ||
    row.providerId.length > 255 ||
    !Number.isInteger(row.revision) ||
    Number(row.revision) <= 0 ||
    typeof row.secretCiphertext !== 'string' ||
    !row.secretCiphertext.startsWith('aihub.secret.v1.') ||
    typeof row.secretFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.secretFingerprint) ||
    checksumPayload(row.payload) !== row.checksum ||
    (row.payload as Record<string, unknown>).secretFingerprint !== row.secretFingerprint
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_PROVIDER_INVALID');
  }
  return row as unknown as IdentityProviderLkgProvider;
};

/**
 * Upper bound for tombstone array length on untrusted decode only (DoS guard).
 * Retention is NOT "keep at most 100 historical IDs" — every still-relevant
 * revocation (removed provider not superseded by a newer live generation) is
 * retained. Live providers remain capped separately at 100; tombstones track
 * historical disables and must survive far beyond that count so a total-DB
 * outage cannot resurrect a recently disabled provider (identity/SVC-ID-006).
 */
const PROVIDER_TOMBSTONE_DECODE_HARD_MAX = 10_000;

const parseProviderTombstones = (value: unknown): IdentityProviderLkgProviderTombstone[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PROVIDER_TOMBSTONE_DECODE_HARD_MAX) {
    throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
  }
  const parsed = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
    }
    const row = entry as Record<string, unknown>;
    if (
      Object.keys(row).length !== 2 ||
      typeof row.providerId !== 'string' ||
      row.providerId.length === 0 ||
      row.providerId.length > 255 ||
      typeof row.generation !== 'string' ||
      row.generation.length === 0 ||
      row.generation.length > 512
    ) {
      throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
    }
    return { generation: row.generation, providerId: row.providerId };
  });
  const ids = parsed.map((entry) => entry.providerId);
  if (new Set(ids).size !== ids.length) {
    throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
  }
  return [...parsed].sort((left, right) => left.providerId.localeCompare(right.providerId));
};

const normalizeProviderTombstones = (
  tombstones: IdentityProviderLkgProviderTombstone[],
  providers: IdentityProviderLkgProvider[],
): IdentityProviderLkgProviderTombstone[] => {
  const liveById = new Map(providers.map((provider) => [provider.providerId, provider]));
  // Live provider with a strictly newer generation supersedes its tombstone (re-enable).
  const normalized = tombstones
    .filter((tombstone) => {
      const live = liveById.get(tombstone.providerId);
      return !live || live.generation <= tombstone.generation;
    })
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
  // Fail loudly at write/merge time — never produce a payload that decode would reject
  // (which would drop the entire LKG and resurrect revoked providers).
  if (normalized.length > PROVIDER_TOMBSTONE_DECODE_HARD_MAX) {
    throw new IdentityProviderLkgError('OIDC_LKG_TOMBSTONE_LIMIT');
  }
  return normalized;
};

const mergeProviderTombstones = (
  current: IdentityProviderLkgProviderTombstone[] | undefined,
  candidate: IdentityProviderLkgProviderTombstone[] | undefined,
  providers: IdentityProviderLkgProvider[],
): IdentityProviderLkgProviderTombstone[] => {
  const map = new Map<string, string>();
  for (const entry of current ?? []) {
    map.set(entry.providerId, entry.generation);
  }
  for (const entry of candidate ?? []) {
    const previous = map.get(entry.providerId);
    if (!previous || entry.generation > previous) {
      map.set(entry.providerId, entry.generation);
    }
  }
  return normalizeProviderTombstones(
    [...map.entries()].map(([providerId, generation]) => ({ generation, providerId })),
    providers,
  );
};

const parsePayload = (value: unknown): IdentityProviderLkgPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
  }
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  const version = payload.version;
  // v1: strict six-field legacy (no providerTombstones). Still loadable.
  // v2: seven fields including providerTombstones (may be empty).
  const isV1 =
    version === IDENTITY_PROVIDER_LKG_VERSION_V1 &&
    keys.length === 6 &&
    !('providerTombstones' in payload);
  const isV2 =
    version === IDENTITY_PROVIDER_LKG_VERSION &&
    keys.length === 7 &&
    'providerTombstones' in payload;
  if (
    (!isV1 && !isV2) ||
    payload.domain !== LKG_DOMAIN ||
    typeof payload.createdAt !== 'string' ||
    Number.isNaN(new Date(payload.createdAt).getTime()) ||
    typeof payload.generation !== 'string' ||
    payload.generation.length === 0 ||
    payload.generation.length > 512 ||
    typeof payload.identityRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.identityRevision) ||
    !Array.isArray(payload.providers) ||
    payload.providers.length > 100
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_PAYLOAD_INVALID');
  }
  const providers = payload.providers.map(parseProvider);
  const providerTombstones = normalizeProviderTombstones(
    // Missing on v1 → []. Present on v2 (including empty).
    parseProviderTombstones(isV1 ? undefined : payload.providerTombstones),
    providers,
  );
  // Generation may exceed the max provider generation when a signed tombstone
  // advanced the snapshot without materializing the removed provider.
  const providerGeneration = identityProviderLkgGeneration(providers);
  if (
    new Set(providers.map((provider) => provider.providerId)).size !== providers.length ||
    identityProviderLkgIdentity(providers) !== payload.identityRevision ||
    payload.generation < providerGeneration
  ) {
    throw new IdentityProviderLkgError('OIDC_LKG_IDENTITY_INVALID');
  }
  return {
    createdAt: payload.createdAt as string,
    domain: LKG_DOMAIN,
    generation: payload.generation as string,
    identityRevision: payload.identityRevision as string,
    providerTombstones,
    providers,
    version: version as IdentityProviderLkgVersion,
  };
};

const maxAgeMs = (env: Record<string, string | undefined>): number => {
  const raw = Number(env.PLATFORM_OIDC_LKG_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 365 * 24 * 60 * 60) : 0;
  return seconds * 1000;
};

const decodePayload = async (input: {
  enforceAge: boolean;
  env: Record<string, string | undefined>;
  path: string;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgPayload> => {
  const raw = await openAndReadSecure(input.path, input.testHooks?.afterFileStat);
  const envelope = parseEnvelope(JSON.parse(raw));
  if (!(await input.secrets.verifyArtifact(LKG_DOMAIN, envelope.ciphertext, envelope.signature))) {
    throw new IdentityProviderLkgError('OIDC_LKG_SIGNATURE_INVALID');
  }
  const payload = parsePayload(JSON.parse(await input.secrets.decrypt(envelope.ciphertext)));
  if (input.enforceAge) {
    const age = Date.now() - new Date(payload.createdAt).getTime();
    if (age < 0 || age > maxAgeMs(input.env)) {
      throw new IdentityProviderLkgError('OIDC_LKG_STALE');
    }
  }
  return payload;
};

export const readIdentityProviderLkg = async (input: {
  /**
   * When false, skip max-age rejection so revoke-time LKG advances still work on
   * an aged but otherwise valid snapshot. Startup reads keep the default (true).
   */
  enforceAge?: boolean;
  env: Record<string, string | undefined>;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgPayload | null> => {
  const path = resolveLkgPath(input.env);
  try {
    await assertSecureDirectory(pathModule.dirname(path), false);
    return await decodePayload({
      ...input,
      enforceAge: input.enforceAge !== false,
      path,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

const reportLkgAdvanceSkipped = (
  reason: IdentityProviderLkgAdvanceSkipReason,
  detail: { removedProviderId?: string },
): IdentityProviderLkgAdvanceResult => {
  // Safe diagnostics only — no secrets, ciphertext, or paths with env material.
  console.warn('[identityProvider.lkg] advance after tombstone skipped', {
    reason,
    removedProviderId: detail.removedProviderId ?? null,
  });
  return { outcome: 'skipped', reason };
};

/**
 * After a signed Disable (tombstone) commits to the database, advance the local
 * out-of-DB LKG so a total database outage in the immediate post-disable window
 * cannot resurrect the revoked provider from a pre-tombstone snapshot.
 *
 * Best-effort: missing LKG, secret/env unavailability, or write rejection must not
 * fail Disable itself. Read→merge→write is one serialized operation under the process
 * write lock so concurrent disables merge rather than resurrect each other. Per-provider
 * tombstone generations prevent a delayed older revoke from undoing a newer re-enable.
 */
export const advanceIdentityProviderLkgAfterTombstone = async (input: {
  env: Record<string, string | undefined>;
  removedProviderId: string;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
  tombstoneGeneration: string;
}): Promise<IdentityProviderLkgAdvanceResult> => {
  if (!input.tombstoneGeneration || !input.removedProviderId) {
    return reportLkgAdvanceSkipped('missing_input', {
      removedProviderId: input.removedProviderId,
    });
  }

  let path: string;
  try {
    path = resolveLkgPath(input.env);
  } catch {
    return reportLkgAdvanceSkipped('read_failed', {
      removedProviderId: input.removedProviderId,
    });
  }

  try {
    return await withProcessWriteLock(path, async () => {
      let current: IdentityProviderLkgPayload;
      try {
        await assertSecureDirectory(pathModule.dirname(path), false);
        current = await decodePayload({
          enforceAge: false,
          env: input.env,
          path,
          secrets: input.secrets,
          testHooks: input.testHooks,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return reportLkgAdvanceSkipped('no_lkg', {
            removedProviderId: input.removedProviderId,
          });
        }
        return reportLkgAdvanceSkipped('read_failed', {
          removedProviderId: input.removedProviderId,
        });
      }

      const live = current.providers.find(
        (provider) => provider.providerId === input.removedProviderId,
      );
      const existingTombstones = current.providerTombstones ?? [];
      const existingTombGeneration = existingTombstones.find(
        (entry) => entry.providerId === input.removedProviderId,
      )?.generation;

      // Re-enable already landed with a generation at least as new as this tombstone.
      if (live && input.tombstoneGeneration <= live.generation) {
        return reportLkgAdvanceSkipped('stale_tombstone', {
          removedProviderId: input.removedProviderId,
        });
      }
      // Provider already removed and we already recorded an equal-or-newer tombstone.
      if (!live && existingTombGeneration && input.tombstoneGeneration <= existingTombGeneration) {
        return 'unchanged';
      }

      const providers = current.providers.filter(
        (provider) => provider.providerId !== input.removedProviderId,
      );
      if (
        providers.length === current.providers.length &&
        existingTombGeneration === input.tombstoneGeneration &&
        input.tombstoneGeneration <= current.generation
      ) {
        return 'unchanged';
      }

      const providerTombstones = mergeProviderTombstones(
        existingTombstones,
        [{ generation: input.tombstoneGeneration, providerId: input.removedProviderId }],
        providers,
      );

      let nextGeneration =
        input.tombstoneGeneration > current.generation
          ? input.tombstoneGeneration
          : `${current.generation}:tombstone`;
      if (nextGeneration <= current.generation) {
        nextGeneration = `${current.generation}:tombstone`;
      }
      if (nextGeneration.length > 512) {
        nextGeneration = nextGeneration.slice(0, 512);
        if (nextGeneration <= current.generation) {
          return reportLkgAdvanceSkipped('generation_overflow', {
            removedProviderId: input.removedProviderId,
          });
        }
      }

      return writeIdentityProviderLkgUnderLock({
        env: input.env,
        path,
        payload: {
          createdAt: new Date().toISOString(),
          domain: LKG_DOMAIN,
          generation: nextGeneration,
          identityRevision: identityProviderLkgIdentity(providers),
          providerTombstones,
          providers,
          version: LKG_WRITE_VERSION,
        },
        secrets: input.secrets,
        testHooks: input.testHooks,
      });
    });
  } catch {
    return reportLkgAdvanceSkipped('write_failed', {
      removedProviderId: input.removedProviderId,
    });
  }
};

const compareSnapshots = (
  current: IdentityProviderLkgPayload,
  candidate: IdentityProviderLkgPayload,
): 'rejected' | 'unchanged' | 'upgrade' => {
  const currentTombstones = new Map(
    (current.providerTombstones ?? []).map((entry) => [entry.providerId, entry.generation]),
  );
  // A delayed/stale re-materialization cannot override a newer per-provider tombstone.
  for (const provider of candidate.providers) {
    const tombGeneration = currentTombstones.get(provider.providerId);
    if (tombGeneration && provider.generation <= tombGeneration) return 'rejected';
  }

  const sameProviders = current.identityRevision === candidate.identityRevision;
  const sameTombstones =
    (current.providerTombstones ?? []).length === (candidate.providerTombstones ?? []).length &&
    (current.providerTombstones ?? []).every((entry, index) => {
      const other = candidate.providerTombstones?.[index];
      return other?.providerId === entry.providerId && other.generation === entry.generation;
    });
  if (sameProviders && sameTombstones) return 'unchanged';
  if (candidate.generation <= current.generation) return 'rejected';
  const candidateById = new Map(
    candidate.providers.map((provider) => [provider.providerId, provider]),
  );
  let upgraded = false;
  for (const existing of current.providers) {
    const next = candidateById.get(existing.providerId);
    // Authenticated monotonic removal (tombstone/revoke): a higher-generation
    // candidate may drop providers so outage LKG cannot resurrect them.
    if (!next) {
      upgraded = true;
      continue;
    }
    if (next.revision < existing.revision) return 'rejected';
    if (next.revision === existing.revision) {
      if (
        next.checksum !== existing.checksum ||
        next.secretFingerprint !== existing.secretFingerprint ||
        next.generation !== existing.generation
      ) {
        return 'rejected';
      }
    } else {
      upgraded = true;
    }
  }
  if (candidate.providers.length > current.providers.length) upgraded = true;
  // Pure removal with higher generation is still an upgrade.
  if (!upgraded && candidate.providers.length < current.providers.length) upgraded = true;
  // New/stronger per-provider tombstones are upgrades even when the live set is identical.
  if (!upgraded && !sameTombstones) {
    for (const entry of candidate.providerTombstones ?? []) {
      const previous = currentTombstones.get(entry.providerId);
      if (!previous || entry.generation > previous) {
        upgraded = true;
        break;
      }
    }
  }
  return upgraded ? 'upgrade' : 'rejected';
};

const ensureExistingTargetIsSecure = async (path: string): Promise<void> => {
  try {
    await openAndReadSecure(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new IdentityProviderLkgError('OIDC_LKG_TARGET_SYMLINK_FORBIDDEN');
    }
    throw error;
  }
};

const removeIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

const parseRevocationJournalPayload = (
  value: unknown,
): IdentityProviderRevocationJournalPayload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
  }
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).length !== 3 ||
    payload.version !== 1 ||
    typeof payload.updatedAt !== 'string' ||
    Number.isNaN(new Date(payload.updatedAt).getTime()) ||
    !Array.isArray(payload.entries) ||
    payload.entries.length > PROVIDER_TOMBSTONE_DECODE_HARD_MAX
  ) {
    throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
  }
  const entries = payload.entries.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
    }
    const entry = value as Record<string, unknown>;
    if (
      (Object.keys(entry).length !== 2 && Object.keys(entry).length !== 3) ||
      typeof entry.providerId !== 'string' ||
      entry.providerId.length === 0 ||
      entry.providerId.length > 255 ||
      typeof entry.token !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(entry.token) ||
      (entry.generation !== undefined &&
        (typeof entry.generation !== 'string' ||
          entry.generation.length === 0 ||
          entry.generation.length > 512))
    ) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
    }
    return {
      ...(typeof entry.generation === 'string' ? { generation: entry.generation } : {}),
      providerId: entry.providerId,
      token: entry.token,
    };
  });
  if (new Set(entries.map(({ token }) => token)).size !== entries.length) {
    throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
  }
  return {
    entries: [...entries].sort((left, right) => left.token.localeCompare(right.token)),
    updatedAt: payload.updatedAt,
    version: 1,
  };
};

const readRevocationJournalAtPath = async (input: {
  path: string;
  secrets: PlatformSecretService;
}): Promise<IdentityProviderRevocationJournalPayload> => {
  try {
    const raw = await openAndReadSecure(input.path);
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
    }
    const envelope = value as Record<string, unknown>;
    if (
      Object.keys(envelope).length !== 4 ||
      envelope.format !== REVOCATION_JOURNAL_FORMAT ||
      envelope.version !== 1 ||
      typeof envelope.ciphertext !== 'string' ||
      typeof envelope.signature !== 'string' ||
      !(await input.secrets.verifyArtifact(
        REVOCATION_JOURNAL_DOMAIN,
        envelope.ciphertext,
        envelope.signature,
      ))
    ) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_INVALID');
    }
    return parseRevocationJournalPayload(
      JSON.parse(await input.secrets.decrypt(envelope.ciphertext)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [], updatedAt: new Date(0).toISOString(), version: 1 };
    }
    throw error;
  }
};

const writeRevocationJournalAtPath = async (input: {
  path: string;
  payload: IdentityProviderRevocationJournalPayload;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<void> => {
  const payload = parseRevocationJournalPayload(input.payload);
  const directory = pathModule.dirname(input.path);
  await assertSecureDirectory(directory, true);
  await ensureExistingTargetIsSecure(input.path);
  const temporaryPath = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const ciphertext = await input.secrets.encrypt(JSON.stringify(payload));
    const envelope: IdentityProviderRevocationJournalEnvelope = {
      ciphertext,
      format: REVOCATION_JOURNAL_FORMAT,
      signature: await input.secrets.signArtifact(REVOCATION_JOURNAL_DOMAIN, ciphertext),
      version: 1,
    };
    const temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await temporary.writeFile(JSON.stringify(envelope), { encoding: 'utf8' });
      await temporary.sync();
      assertSecureFile(await temporary.stat());
    } finally {
      await temporary.close();
    }
    await input.testHooks?.beforeRename?.(temporaryPath);
    await rename(temporaryPath, input.path);
    temporaryCreated = false;
    await openAndReadSecure(input.path);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryCreated) await removeIfPresent(temporaryPath);
  }
};

/**
 * Process-local write serialization for LKG paths.
 *
 * ACCEPTABLE for the single-instance demo: overlapping Disable/LKG advances in the
 * same Node process queue through `writeQueues` so read→merge→rename cannot interleave.
 *
 * DEFERRED LIMITATION (multi-instance): there is no cross-process filesystem lock or
 * persisted-generation CAS. Concurrent Disable from separate processes/replicas can
 * still race on the LKG file. Documented as identity/F10 single-instance scope; do not
 * treat the overlap unit test as multi-process proof.
 */
const writeQueues = new Map<string, Promise<void>>();

const withProcessWriteLock = async <T>(path: string, work: () => Promise<T>): Promise<T> => {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  writeQueues.set(path, queued);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (writeQueues.get(path) === queued) writeQueues.delete(path);
  }
};

/**
 * Write body that assumes the process write lock for `path` is already held.
 * Used by public write and by tombstone advance so read→merge→write stays atomic.
 * Always persists the current write version (v2) so on-disk shape is versioned.
 */
const writeIdentityProviderLkgUnderLock = async (input: {
  env: Record<string, string | undefined>;
  path: string;
  payload: IdentityProviderLkgPayload;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgWriteResult> => {
  // Normalize to write-version shape before compare/persist (v1 inputs upgrade on write).
  const requested = parsePayload({
    ...input.payload,
    providerTombstones: input.payload.providerTombstones ?? [],
    version: LKG_WRITE_VERSION,
  });
  const directory = pathModule.dirname(input.path);
  await assertSecureDirectory(directory, true);
  await ensureExistingTargetIsSecure(input.path);

  let current: IdentityProviderLkgPayload | null = null;
  try {
    current = await decodePayload({
      enforceAge: false,
      env: input.env,
      path: input.path,
      secrets: input.secrets,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const providerTombstones = mergeProviderTombstones(
    current?.providerTombstones,
    requested.providerTombstones,
    requested.providers,
  );
  const payload: IdentityProviderLkgPayload = {
    ...requested,
    providerTombstones,
    version: LKG_WRITE_VERSION,
  };

  if (current) {
    const comparison = compareSnapshots(current, payload);
    if (comparison !== 'upgrade') return comparison;
  }

  const temporaryPath = `${input.path}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const plaintext = JSON.stringify(payload);
    const ciphertext = await input.secrets.encrypt(plaintext);
    const envelope: IdentityProviderLkgEnvelope = {
      ciphertext,
      format: LKG_FORMAT,
      signature: await input.secrets.signArtifact(LKG_DOMAIN, ciphertext),
      version: LKG_WRITE_VERSION,
    };
    const temporary = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    temporaryCreated = true;
    try {
      await temporary.writeFile(JSON.stringify(envelope), { encoding: 'utf8' });
      await temporary.sync();
      assertSecureFile(await temporary.stat());
    } finally {
      await temporary.close();
    }
    await input.testHooks?.beforeRename?.(temporaryPath);
    await rename(temporaryPath, input.path);
    temporaryCreated = false;
    await openAndReadSecure(input.path);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return 'written';
  } finally {
    if (temporaryCreated) await removeIfPresent(temporaryPath);
  }
};

export const writeIdentityProviderLkg = async (input: {
  env: Record<string, string | undefined>;
  payload: IdentityProviderLkgPayload;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<IdentityProviderLkgWriteResult> => {
  const path = resolveLkgPath(input.env);
  return withProcessWriteLock(path, async () =>
    writeIdentityProviderLkgUnderLock({
      env: input.env,
      path,
      payload: input.payload,
      secrets: input.secrets,
      testHooks: input.testHooks,
    }),
  );
};

/** Read the independently authenticated fail-closed revocation journal. */
export const readIdentityProviderRevocationJournal = async (input: {
  env: Record<string, string | undefined>;
  secrets: PlatformSecretService;
}): Promise<IdentityProviderRevocationJournalEntry[]> => {
  const path = resolveRevocationJournalPath(input.env);
  await assertSecureDirectory(pathModule.dirname(path), false);
  return (await readRevocationJournalAtPath({ path, secrets: input.secrets })).entries;
};

/**
 * Persist a pending denial before the database tombstone is attempted.
 * The token binds later finalize/clear operations to this exact disable attempt.
 */
export const recordIdentityProviderRevocation = async (input: {
  env: Record<string, string | undefined>;
  providerId: string;
  secrets: PlatformSecretService;
  testHooks?: IdentityProviderLkgTestHooks;
}): Promise<string> => {
  const path = resolveRevocationJournalPath(input.env);
  const token = randomUUID();
  await withProcessWriteLock(path, async () => {
    const current = await readRevocationJournalAtPath({ path, secrets: input.secrets });
    await writeRevocationJournalAtPath({
      path,
      payload: {
        entries: [...current.entries, { providerId: input.providerId, token }],
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      secrets: input.secrets,
      testHooks: input.testHooks,
    });
  });
  return token;
};

/** Attach the committed immutable tombstone generation to a pending denial. */
export const finalizeIdentityProviderRevocation = async (input: {
  env: Record<string, string | undefined>;
  generation: string;
  secrets: PlatformSecretService;
  token: string;
}): Promise<void> => {
  const path = resolveRevocationJournalPath(input.env);
  await withProcessWriteLock(path, async () => {
    const current = await readRevocationJournalAtPath({ path, secrets: input.secrets });
    const entries = current.entries.map((entry) =>
      entry.token === input.token ? { ...entry, generation: input.generation } : entry,
    );
    if (!entries.some((entry) => entry.token === input.token)) {
      throw new IdentityProviderLkgError('OIDC_REVOCATION_JOURNAL_ENTRY_MISSING');
    }
    await writeRevocationJournalAtPath({
      path,
      payload: { entries, updatedAt: new Date().toISOString(), version: 1 },
      secrets: input.secrets,
    });
  });
};

/** Remove only the exact attempt entry after the main LKG is proven safe. */
export const clearIdentityProviderRevocation = async (input: {
  env: Record<string, string | undefined>;
  secrets: PlatformSecretService;
  token: string;
}): Promise<void> => {
  const path = resolveRevocationJournalPath(input.env);
  await withProcessWriteLock(path, async () => {
    const current = await readRevocationJournalAtPath({ path, secrets: input.secrets });
    const entries = current.entries.filter((entry) => entry.token !== input.token);
    if (entries.length === current.entries.length) return;
    await writeRevocationJournalAtPath({
      path,
      payload: { entries, updatedAt: new Date().toISOString(), version: 1 },
      secrets: input.secrets,
    });
  });
};
