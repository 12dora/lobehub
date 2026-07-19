import { isPlainRecord } from '@lobechat/utils/object';

import {
  type PlatformSecretEnv,
  VAULT_ADDR_ENV,
  VAULT_APPROLE_MOUNT_PATH_ENV,
  VAULT_APPROLE_ROLE_ID_ENV,
  VAULT_APPROLE_SECRET_ID_ENV,
  VAULT_KV_MOUNT_PATH_ENV,
  VAULT_KV_SECRET_PATH_ENV,
  VAULT_TOKEN_ENV,
} from '../config';
import { PlatformSecretError, secretInvalidInput, secretNotReadable } from '../errors';
import type { KekMaterial, KeyProvider } from './types';

const AES_256_KEY_BYTES = 32;
const DEFAULT_ADDRESS = 'http://127.0.0.1:8200';
const DEFAULT_AUTH_MOUNT_PATH = 'approle';
const DEFAULT_KV_MOUNT_PATH = 'aihub';
const DEFAULT_SECRET_PATH = 'platform/master-key';
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_TOKEN_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_KEY_CACHE_TTL_MS = 30_000;
const DEFAULT_RENEW_BEFORE_MS = 30_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TOKEN_CACHE_TTL_MS = 15 * 60_000;
const MAX_KEY_CACHE_TTL_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HISTORICAL_KEYS = 256;
const MIN_CACHE_TTL_MS = 100;
const SAFE_PATH_SEGMENT = /^[A-Z0-9][\w.-]{0,127}$/i;
const SAFE_MOUNT_PATH = /^[A-Z0-9][\w-]{0,63}$/i;
const SAFE_KEY_ID = /^[A-Z0-9][\w.:@+-]{0,127}$/i;
const BASE64_KEY = /^[A-Z0-9+/]{43}=$/i;
const GENERIC_UNAVAILABLE_MESSAGE = 'Vault key material is unavailable';

export interface VaultAppRoleAuth {
  authMountPath?: string;
  method: 'approle';
  roleId: string;
  secretId: string;
}

export interface VaultTokenAuth {
  method: 'token';
  token: string;
}

export type VaultAuth = VaultAppRoleAuth | VaultTokenAuth;

export interface VaultKeyProviderOptions {
  /** Vault API origin. Credentials in URLs are rejected. */
  address?: string;
  auth: VaultAuth;
  /** Injectable wall clock for deterministic lease/cache tests. */
  clock?: () => number;
  /** Injectable fetch boundary for tests. */
  fetch?: typeof fetch;
  /** Bounded cache for a validated KV snapshot. */
  keyCacheTtlMs?: number;
  /** KV v2 mount name (default: aihub). */
  mountPath?: string;
  /** Renew a renewable token this long before its effective expiry. */
  renewBeforeMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Secret path below the KV v2 mount, without data/. */
  secretPath?: string;
  /** Upper bound for caching an otherwise longer-lived token. */
  tokenCacheTtlMs?: number;
}

interface ValidatedToken {
  expiresAt: number;
  renewable: boolean;
  value: string;
}

interface KeySnapshot {
  activeKeyId: string;
  expiresAt: number;
  keys: Map<string, Uint8Array>;
}

interface TokenMetadata {
  leaseDurationSeconds: number;
  renewable: boolean;
}

const validateBoundedInteger = (value: number, name: string, minimum: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw secretInvalidInput(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
};

const validateCredential = (value: string, name: string): string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4096 ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw secretInvalidInput(`${name} is missing or invalid`);
  }
  return value;
};

const validateMountPath = (value: string, name: string): string => {
  if (!SAFE_MOUNT_PATH.test(value)) throw secretInvalidInput(`${name} is invalid`);
  return value;
};

const validateSecretPath = (value: string): string => {
  if (value.length === 0 || value.length > 512) {
    throw secretInvalidInput('Vault secret path is invalid');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !SAFE_PATH_SEGMENT.test(segment))) {
    throw secretInvalidInput('Vault secret path is invalid');
  }
  return segments.map(encodeURIComponent).join('/');
};

const validateAddress = (value: string): URL => {
  let address: URL;
  try {
    address = new URL(value);
  } catch {
    throw secretInvalidInput('Vault address is invalid');
  }
  if (
    !['http:', 'https:'].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    (address.pathname !== '/' && address.pathname !== '')
  ) {
    throw secretInvalidInput('Vault address must be an HTTP(S) origin without credentials');
  }
  return address;
};

const parsePolicies = (value: unknown): string[] => {
  if (
    !Array.isArray(value) ||
    value.some((policy) => typeof policy !== 'string' || policy.length === 0)
  ) {
    return [];
  }
  return value;
};

const assertNotRoot = (policies: string[]) => {
  if (policies.includes('root')) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'root-token-rejected' });
  }
};

const parseLookupMetadata = (payload: unknown): TokenMetadata => {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.data)) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-token-metadata' });
  }
  const policies = parsePolicies(payload.data.policies);
  if (policies.length === 0) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-token-metadata' });
  }
  if (
    typeof payload.data.ttl !== 'number' ||
    !Number.isSafeInteger(payload.data.ttl) ||
    payload.data.ttl < 0 ||
    typeof payload.data.renewable !== 'boolean'
  ) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-token-metadata' });
  }
  assertNotRoot(policies);
  return {
    leaseDurationSeconds: payload.data.ttl,
    renewable: payload.data.renewable,
  };
};

const parseLoginToken = (payload: unknown): string => {
  if (!isPlainRecord(payload) || !isPlainRecord(payload.auth)) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-auth-response' });
  }
  return validateCredential(payload.auth.client_token as string, 'Vault client token');
};

const decodeKek = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || !BASE64_KEY.test(value)) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-key-schema' });
  }
  const key = Buffer.from(value, 'base64');
  if (key.length !== AES_256_KEY_BYTES || key.toString('base64') !== value) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-key-schema' });
  }
  return new Uint8Array(key);
};

const assertExactKeys = (value: Record<string, unknown>, expected: string[]) => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-key-schema' });
  }
};

const parseKeyEntry = (value: unknown): { key: Uint8Array; keyId: string } => {
  if (!isPlainRecord(value)) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-key-schema' });
  }
  assertExactKeys(value, ['key', 'keyId']);
  if (typeof value.keyId !== 'string' || !SAFE_KEY_ID.test(value.keyId)) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-key-schema' });
  }
  return { key: decodeKek(value.key), keyId: value.keyId };
};

const parseKeySnapshot = (payload: unknown, expiresAt: number): KeySnapshot => {
  if (
    !isPlainRecord(payload) ||
    !isPlainRecord(payload.data) ||
    !isPlainRecord(payload.data.data)
  ) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-key-schema' });
  }
  const secret = payload.data.data;
  assertExactKeys(secret, ['active', 'historical']);
  if (!Array.isArray(secret.historical) || secret.historical.length > MAX_HISTORICAL_KEYS) {
    throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-key-schema' });
  }
  const active = parseKeyEntry(secret.active);
  const historical = secret.historical.map(parseKeyEntry);
  const keys = new Map<string, Uint8Array>([[active.keyId, active.key]]);
  for (const entry of historical) {
    if (keys.has(entry.keyId)) {
      throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'duplicate-key-id' });
    }
    keys.set(entry.keyId, entry.key);
  }
  return { activeKeyId: active.keyId, expiresAt, keys };
};

/**
 * Production Vault KV v2 key provider.
 *
 * Authentication and KV reads are single-flight and bounded by short caches.
 * Every client token is verified with lookup-self and root policy is rejected.
 * All transport/schema failures are exposed as one sanitized fail-closed error.
 */
export class VaultKeyProvider implements KeyProvider {
  readonly providerId = 'vault';

  private readonly address: URL;
  private readonly auth: VaultAuth;
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;
  private readonly keyCacheTtlMs: number;
  private readonly mountPath: string;
  private readonly renewBeforeMs: number;
  private readonly requestTimeoutMs: number;
  private readonly secretPath: string;
  private readonly tokenCacheTtlMs: number;
  private keySnapshot?: KeySnapshot;
  private keySnapshotPromise?: Promise<KeySnapshot>;
  private token?: ValidatedToken;
  private tokenPromise?: Promise<ValidatedToken>;

  constructor(options: VaultKeyProviderOptions) {
    this.address = validateAddress(options.address ?? DEFAULT_ADDRESS);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? Date.now;
    this.mountPath = validateMountPath(
      options.mountPath ?? DEFAULT_KV_MOUNT_PATH,
      'Vault KV mount',
    );
    this.secretPath = validateSecretPath(options.secretPath ?? DEFAULT_SECRET_PATH);
    this.requestTimeoutMs = validateBoundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'Vault request timeout',
      100,
      MAX_REQUEST_TIMEOUT_MS,
    );
    this.tokenCacheTtlMs = validateBoundedInteger(
      options.tokenCacheTtlMs ?? DEFAULT_TOKEN_CACHE_TTL_MS,
      'Vault token cache TTL',
      MIN_CACHE_TTL_MS,
      MAX_TOKEN_CACHE_TTL_MS,
    );
    this.keyCacheTtlMs = validateBoundedInteger(
      options.keyCacheTtlMs ?? DEFAULT_KEY_CACHE_TTL_MS,
      'Vault key cache TTL',
      MIN_CACHE_TTL_MS,
      MAX_KEY_CACHE_TTL_MS,
    );
    this.renewBeforeMs = validateBoundedInteger(
      options.renewBeforeMs ?? DEFAULT_RENEW_BEFORE_MS,
      'Vault renew window',
      0,
      MAX_TOKEN_CACHE_TTL_MS,
    );
    if (options.auth.method === 'approle') {
      this.auth = {
        authMountPath: validateMountPath(
          options.auth.authMountPath ?? DEFAULT_AUTH_MOUNT_PATH,
          'Vault AppRole auth mount',
        ),
        method: 'approle',
        roleId: validateCredential(options.auth.roleId, 'Vault AppRole role ID'),
        secretId: validateCredential(options.auth.secretId, 'Vault AppRole secret ID'),
      };
    } else {
      this.auth = {
        method: 'token',
        token: validateCredential(options.auth.token, 'Vault token'),
      };
    }
    Object.defineProperties(this, {
      auth: { enumerable: false },
      keySnapshot: { configurable: true, enumerable: false, value: undefined, writable: true },
      token: { configurable: true, enumerable: false, value: undefined, writable: true },
    });
  }

  async getKek(keyId?: string): Promise<KekMaterial> {
    if (keyId !== undefined && !SAFE_KEY_ID.test(keyId)) {
      throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'unknown-key-id' });
    }
    const snapshot = await this.getKeySnapshot();
    const resolvedKeyId = keyId ?? snapshot.activeKeyId;
    const key = snapshot.keys.get(resolvedKeyId);
    if (!key) {
      throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'unknown-key-id' });
    }
    return { key: new Uint8Array(key), keyId: resolvedKeyId };
  }

  /** Prevent credentials and cached token/key material from generic serialization. */
  toJSON(): { providerId: string } {
    return { providerId: this.providerId };
  }

  static fromEnv(env: PlatformSecretEnv = process.env): VaultKeyProvider {
    const token = env[VAULT_TOKEN_ENV];
    const roleId = env[VAULT_APPROLE_ROLE_ID_ENV];
    const secretId = env[VAULT_APPROLE_SECRET_ID_ENV];
    if (roleId || secretId) {
      if (!roleId || !secretId) {
        throw secretInvalidInput('Vault AppRole requires both role ID and secret ID');
      }
      return new VaultKeyProvider({
        address: env[VAULT_ADDR_ENV]?.trim(),
        auth: {
          authMountPath: env[VAULT_APPROLE_MOUNT_PATH_ENV]?.trim(),
          method: 'approle',
          roleId,
          secretId,
        },
        mountPath: env[VAULT_KV_MOUNT_PATH_ENV]?.trim(),
        secretPath: env[VAULT_KV_SECRET_PATH_ENV]?.trim(),
      });
    }
    if (!token) throw secretInvalidInput('Vault authentication is not configured');
    return new VaultKeyProvider({
      address: env[VAULT_ADDR_ENV]?.trim(),
      auth: { method: 'token', token },
      mountPath: env[VAULT_KV_MOUNT_PATH_ENV]?.trim(),
      secretPath: env[VAULT_KV_SECRET_PATH_ENV]?.trim(),
    });
  }

  private getKeySnapshot = async (): Promise<KeySnapshot> => {
    const now = this.clock();
    if (this.keySnapshot && now < this.keySnapshot.expiresAt) return this.keySnapshot;
    if (this.keySnapshotPromise) return this.keySnapshotPromise;
    const promise = this.readKeySnapshot();
    this.keySnapshotPromise = promise;
    try {
      const snapshot = await promise;
      if (this.keySnapshot && this.keySnapshot !== snapshot) {
        for (const key of this.keySnapshot.keys.values()) key.fill(0);
      }
      this.keySnapshot = snapshot;
      return snapshot;
    } finally {
      if (this.keySnapshotPromise === promise) this.keySnapshotPromise = undefined;
    }
  };

  private readKeySnapshot = async (): Promise<KeySnapshot> => {
    const token = await this.getToken();
    const payload = await this.request(
      `v1/${encodeURIComponent(this.mountPath)}/data/${this.secretPath}`,
      { method: 'GET' },
      token.value,
    );
    return parseKeySnapshot(payload, Math.min(this.clock() + this.keyCacheTtlMs, token.expiresAt));
  };

  private getToken = async (): Promise<ValidatedToken> => {
    const now = this.clock();
    if (this.token && now < this.token.expiresAt - this.renewBeforeMs) return this.token;
    if (this.tokenPromise) return this.tokenPromise;
    const promise = this.refreshToken();
    this.tokenPromise = promise;
    try {
      const token = await promise;
      this.token = token;
      return token;
    } finally {
      if (this.tokenPromise === promise) this.tokenPromise = undefined;
    }
  };

  private refreshToken = async (): Promise<ValidatedToken> => {
    const current = this.token;
    if (current && this.clock() < current.expiresAt && current.renewable) {
      try {
        await this.request(
          'v1/auth/token/renew-self',
          { body: '{}', method: 'POST' },
          current.value,
        );
        return await this.validateToken(current.value);
      } catch (error) {
        if (this.auth.method === 'token') throw error;
      }
    }

    if (this.auth.method === 'token') return this.validateToken(this.auth.token);

    const payload = await this.request(
      `v1/auth/${encodeURIComponent(this.auth.authMountPath ?? DEFAULT_AUTH_MOUNT_PATH)}/login`,
      {
        body: JSON.stringify({ role_id: this.auth.roleId, secret_id: this.auth.secretId }),
        method: 'POST',
      },
    );
    return this.validateToken(parseLoginToken(payload));
  };

  private validateToken = async (value: string): Promise<ValidatedToken> => {
    const payload = await this.request('v1/auth/token/lookup-self', { method: 'GET' }, value);
    const metadata = parseLookupMetadata(payload);
    const leaseMs = metadata.leaseDurationSeconds * 1000;
    const effectiveTtlMs =
      leaseMs > 0 ? Math.min(leaseMs, this.tokenCacheTtlMs) : this.tokenCacheTtlMs;
    return {
      expiresAt: this.clock() + effectiveTtlMs,
      renewable: metadata.renewable,
      value,
    };
  };

  private request = async (
    path: string,
    init: Pick<RequestInit, 'body' | 'method'>,
    token?: string,
  ): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (init.body) headers['Content-Type'] = 'application/json';
      if (token) headers['X-Vault-Token'] = token;
      const response = await this.fetcher(new URL(path, this.address), {
        ...init,
        headers,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, {
          reason: response.status === 403 ? 'permission-denied' : 'vault-http-error',
          status: response.status,
        });
      }
      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (contentLength > MAX_RESPONSE_BYTES) {
        throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'response-too-large' });
      }
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
        throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'response-too-large' });
      }
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, { reason: 'invalid-json' });
      }
    } catch (error) {
      if (error instanceof PlatformSecretError) throw error;
      throw secretNotReadable(GENERIC_UNAVAILABLE_MESSAGE, {
        reason: controller.signal.aborted ? 'request-timeout' : 'network-error',
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}
