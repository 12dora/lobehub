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

/**
 * Computed on admin writes only and used as (a) the lookup key into
 * `platform_ai_provider_secrets` and (b) a change signal in the catalog authority token.
 * It is NEVER re-verified against the plaintext on read.
 *
 * DELIBERATE DEVIATION for shared-OAuth token rotation: server-side refresh
 * (`sharedOAuthRefresh.ts`) CAS-rewrites the ciphertext IN PLACE at the existing
 * fingerprint, because published revisions are immutable (they pin this fingerprint) and
 * a rotation must stay invisible to the catalog-drift machinery. After a rotation the
 * fingerprint therefore no longer equals sha256(current plaintext) — do not add a
 * read-time fingerprint equality assertion, and treat "same fingerprint, changed
 * ciphertext" as expected for rotating-refresh OAuth providers (the KEK rewrap worker's
 * concurrent-change classification already tolerates it via ciphertext CAS).
 */
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

/**
 * Merge overlay + explicit deletes. `unset` runs AFTER the overlay so a caller can rewrite a
 * group of related leaves in one mutation and drop the ones the new payload does not carry
 * (an overlay alone can only ever add or replace, never remove).
 */
const mergeSecretFields = (
  existing: PlatformProviderKeyVaults,
  mutation: { unset?: string[]; value: PlatformProviderKeyVaults | string },
): PlatformProviderKeyVaults => {
  const merged: PlatformProviderKeyVaults = {
    ...existing,
    ...filterNonEmptySecretFields(mutation.value),
  };
  for (const key of mutation.unset ?? []) delete merged[key];
  return merged;
};

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
      return mergeSecretFields(existing, mutation);
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
      keyVaults = mergeSecretFields(existing, mutation);
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

  /**
   * Re-encrypt a rotated vault WITHOUT recomputing the fingerprint — used only by the
   * shared-OAuth token rotation (see the deviation note on {@link fingerprintSecret}).
   * Never use this for admin-driven secret mutations; those go through applyMutation.
   */
  encryptVaultForRotation = async (
    keyVaults: PlatformProviderKeyVaults,
  ): Promise<{ ciphertext: string; keyId: string }> => {
    const ciphertext = await this.secrets.encrypt(JSON.stringify(keyVaults));
    return { ciphertext, keyId: this.secrets.peekKeyId(ciphertext) };
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
