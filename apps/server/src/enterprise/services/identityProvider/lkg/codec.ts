import pathModule from 'node:path';

import { checksumPayload } from '@/database/models/platform';

import type { PlatformSecretService } from '../../../security/secret';
import {
  IdentityProviderLkgError,
  type IdentityProviderLkgTestHooks,
  openAndReadSecure,
} from './secureFile';

export const LKG_DOMAIN = 'platform-oidc-lkg';
export const LKG_FORMAT = 'aihub.platform.oidc-lkg';
/** Legacy on-disk snapshot (six payload fields, no providerTombstones). Still readable. */
export const IDENTITY_PROVIDER_LKG_VERSION_V1 = 1;
/**
 * Current write version. Adds optional-on-read `providerTombstones[]` for concurrent-disable
 * merge and stale-tombstone protection. Writers always emit this version; readers still accept
 * v1 six-field snapshots (missing tombstones → []).
 */
export const IDENTITY_PROVIDER_LKG_VERSION = 2;
export const LKG_WRITE_VERSION = IDENTITY_PROVIDER_LKG_VERSION;
const DEFAULT_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const EMPTY_GENERATION = '0000-01-01T00:00:00.000Z:';

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

export interface IdentityProviderLkgEnvelope {
  ciphertext: string;
  format: typeof LKG_FORMAT;
  signature: string;
  version: IdentityProviderLkgVersion;
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

export const resolveLkgPath = (env: Record<string, string | undefined>): string => {
  const configured = env.PLATFORM_OIDC_LKG_PATH?.trim();
  if (!configured) return pathModule.join(process.cwd(), '.lobe', 'platform-oidc-lkg.v1.json');
  if (!pathModule.isAbsolute(configured) || pathModule.normalize(configured) !== configured) {
    throw new IdentityProviderLkgError('OIDC_LKG_PATH_INVALID');
  }
  return configured;
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
export const PROVIDER_TOMBSTONE_DECODE_HARD_MAX = 10_000;

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

export const mergeProviderTombstones = (
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

export const parsePayload = (value: unknown): IdentityProviderLkgPayload => {
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

export const decodePayload = async (input: {
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

const tombstoneRejectsCandidate = (
  current: IdentityProviderLkgPayload,
  candidate: IdentityProviderLkgPayload,
): boolean => {
  const currentTombstones = new Map(
    (current.providerTombstones ?? []).map((entry) => [entry.providerId, entry.generation]),
  );
  // A delayed/stale re-materialization cannot override a newer per-provider tombstone.
  for (const provider of candidate.providers) {
    const tombGeneration = currentTombstones.get(provider.providerId);
    if (tombGeneration && provider.generation <= tombGeneration) return true;
  }
  return false;
};

const sameTombstoneSet = (
  a: IdentityProviderLkgProviderTombstone[] | undefined,
  b: IdentityProviderLkgProviderTombstone[] | undefined,
): boolean =>
  (a ?? []).length === (b ?? []).length &&
  (a ?? []).every((entry, index) => {
    const other = b?.[index];
    return other?.providerId === entry.providerId && other.generation === entry.generation;
  });

const providerSetDecision = (
  current: IdentityProviderLkgPayload,
  candidate: IdentityProviderLkgPayload,
): 'rejected' | 'upgraded' | 'same' => {
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
  return upgraded ? 'upgraded' : 'same';
};

export const compareSnapshots = (
  current: IdentityProviderLkgPayload,
  candidate: IdentityProviderLkgPayload,
): 'rejected' | 'unchanged' | 'upgrade' => {
  if (tombstoneRejectsCandidate(current, candidate)) return 'rejected';

  const sameProviders = current.identityRevision === candidate.identityRevision;
  const sameTombstones = sameTombstoneSet(current.providerTombstones, candidate.providerTombstones);
  if (sameProviders && sameTombstones) return 'unchanged';
  if (candidate.generation <= current.generation) return 'rejected';

  const providerDecision = providerSetDecision(current, candidate);
  if (providerDecision === 'rejected') return 'rejected';
  let upgraded = providerDecision === 'upgraded';
  // New/stronger per-provider tombstones are upgrades even when the live set is identical.
  if (!upgraded && !sameTombstones) {
    const currentTombstones = new Map(
      (current.providerTombstones ?? []).map((entry) => [entry.providerId, entry.generation]),
    );
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
