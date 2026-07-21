import { createHash } from 'node:crypto';

import type { z } from 'zod';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

import type { aiSecretMutationSchema } from '../../contracts/aiCatalog';

export type AiSecretMutation = z.infer<typeof aiSecretMutationSchema>;

export interface AppliedAiSecret {
  encryptedKeyVaults: string | null;
  secretFingerprint: string | null;
  secretKeyId: string | null;
  secretKeyVersion: number | null;
  secretUpdatedAt: Date | null;
}

export interface PlatformProviderKeyVaults {
  [key: string]: Record<string, string> | string | undefined;
  apiKey?: string;
  baseURL?: string;
  customHeaders?: Record<string, string>;
}

export const toDefinedPlatformKeyVaults = (
  keyVaults: PlatformProviderKeyVaults,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(keyVaults).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );

const fingerprintSecret = (plaintext: string): string =>
  `sha256:${createHash('sha256').update(plaintext).digest('hex').slice(0, 16)}`;

/** Drop empty-string leaves; keep nested objects (e.g. customHeaders) as-is when non-empty. */
export const filterNonEmptySecretFields = (
  value: PlatformProviderKeyVaults | string,
): PlatformProviderKeyVaults => {
  const raw = typeof value === 'string' ? { apiKey: value } : value;
  const result: PlatformProviderKeyVaults = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (typeof entry === 'string') {
      if (entry.length > 0) result[key] = entry;
      continue;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const nested = Object.fromEntries(
        Object.entries(entry).filter(([, v]) => typeof v === 'string' && v.length > 0),
      );
      if (Object.keys(nested).length > 0) result[key] = nested;
    }
  }
  return result;
};

const toVaultObject = (value: string | PlatformProviderKeyVaults): PlatformProviderKeyVaults =>
  typeof value === 'string' ? { apiKey: value } : value;

/** Applies keep/replace/merge/clear without ever returning plaintext or logging it. */
export class AiCatalogSecretManager {
  private readonly secrets: PlatformSecretService;

  constructor(secrets: PlatformSecretService) {
    this.secrets = secrets;
  }

  resolveMutationKeyVaults = async (
    current: Pick<PlatformAiProviderItem, 'encryptedKeyVaults'> | null,
    mutation: AiSecretMutation | undefined,
  ): Promise<PlatformProviderKeyVaults> => {
    if (mutation?.operation === 'replace') {
      return typeof mutation.value === 'string' ? { apiKey: mutation.value } : mutation.value;
    }
    if (mutation?.operation === 'merge') {
      const existing = current?.encryptedKeyVaults
        ? await this.decrypt(current.encryptedKeyVaults)
        : {};
      const incoming = filterNonEmptySecretFields(mutation.value);
      return { ...existing, ...incoming };
    }
    if (mutation?.operation === 'clear') return {};
    return current?.encryptedKeyVaults ? this.decrypt(current.encryptedKeyVaults) : {};
  };

  applyMutation = async (
    current: Pick<
      PlatformAiProviderItem,
      | 'encryptedKeyVaults'
      | 'secretFingerprint'
      | 'secretKeyId'
      | 'secretKeyVersion'
      | 'secretUpdatedAt'
    > | null,
    mutation: AiSecretMutation | undefined,
  ): Promise<AppliedAiSecret> => {
    if (!mutation || mutation.operation === 'keep') {
      const encryptedKeyVaults = current?.encryptedKeyVaults ?? null;
      return {
        encryptedKeyVaults,
        secretFingerprint: current?.secretFingerprint ?? null,
        secretKeyId: encryptedKeyVaults ? this.secrets.peekKeyId(encryptedKeyVaults) : null,
        secretKeyVersion: current?.secretKeyVersion ?? null,
        secretUpdatedAt: current?.secretUpdatedAt ?? null,
      };
    }

    if (mutation.operation === 'clear') {
      return {
        encryptedKeyVaults: null,
        secretFingerprint: null,
        secretKeyId: null,
        secretKeyVersion: null,
        secretUpdatedAt: null,
      };
    }

    let keyVaults: PlatformProviderKeyVaults;
    if (mutation.operation === 'merge') {
      const existing = current?.encryptedKeyVaults
        ? await this.decrypt(current.encryptedKeyVaults)
        : {};
      const incoming = filterNonEmptySecretFields(mutation.value);
      keyVaults = { ...existing, ...incoming };
    } else {
      // replace
      keyVaults = toVaultObject(mutation.value);
    }

    const serialized = JSON.stringify(keyVaults);
    const encryptedKeyVaults = await this.secrets.encrypt(serialized);
    return {
      encryptedKeyVaults,
      secretFingerprint: fingerprintSecret(serialized),
      secretKeyId: this.secrets.peekKeyId(encryptedKeyVaults),
      secretKeyVersion: 1,
      secretUpdatedAt: new Date(),
    };
  };

  decrypt = async (ciphertext: string): Promise<PlatformProviderKeyVaults> => {
    const plaintext = await this.secrets.decrypt(ciphertext);
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('PLATFORM_SECRET_NOT_READABLE');
    }
    for (const [key, value] of Object.entries(parsed)) {
      const validNestedHeaders =
        key === 'customHeaders' &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every((item) => typeof item === 'string');
      if (value !== undefined && typeof value !== 'string' && !validNestedHeaders) {
        throw new Error('PLATFORM_SECRET_NOT_READABLE');
      }
    }
    return parsed as PlatformProviderKeyVaults;
  };

  /** Extract the envelope KEK id without exposing key material or plaintext. */
  peekKeyId = (ciphertext: string): string => this.secrets.peekKeyId(ciphertext);
}
