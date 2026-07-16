import { createHash } from 'node:crypto';

import type { z } from 'zod';

import type { PlatformAiProviderItem } from '@/database/schemas/platform';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

import type { aiSecretMutationSchema } from '../../contracts/aiCatalog';

export type AiSecretMutation = z.infer<typeof aiSecretMutationSchema>;

export interface AppliedAiSecret {
  encryptedKeyVaults: string | null;
  secretFingerprint: string | null;
  secretKeyVersion: number | null;
  secretUpdatedAt: Date | null;
}

export interface PlatformProviderKeyVaults {
  [key: string]: string | undefined;
  apiKey?: string;
  baseURL?: string;
}

const fingerprintSecret = (plaintext: string): string =>
  `sha256:${createHash('sha256').update(plaintext).digest('hex').slice(0, 16)}`;

/** Applies keep/replace/clear without ever returning plaintext or logging it. */
export class AiCatalogSecretManager {
  private readonly secrets: PlatformSecretService;

  constructor(secrets: PlatformSecretService) {
    this.secrets = secrets;
  }

  applyMutation = async (
    current: Pick<
      PlatformAiProviderItem,
      'encryptedKeyVaults' | 'secretFingerprint' | 'secretKeyVersion' | 'secretUpdatedAt'
    > | null,
    mutation: AiSecretMutation | undefined,
  ): Promise<AppliedAiSecret> => {
    if (!mutation || mutation.operation === 'keep') {
      return {
        encryptedKeyVaults: current?.encryptedKeyVaults ?? null,
        secretFingerprint: current?.secretFingerprint ?? null,
        secretKeyVersion: current?.secretKeyVersion ?? null,
        secretUpdatedAt: current?.secretUpdatedAt ?? null,
      };
    }

    if (mutation.operation === 'clear') {
      return {
        encryptedKeyVaults: null,
        secretFingerprint: null,
        secretKeyVersion: null,
        secretUpdatedAt: null,
      };
    }

    const serialized = JSON.stringify({ apiKey: mutation.value });
    const encryptedKeyVaults = await this.secrets.encrypt(serialized);
    return {
      encryptedKeyVaults,
      secretFingerprint: fingerprintSecret(serialized),
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
    for (const value of Object.values(parsed)) {
      if (value !== undefined && typeof value !== 'string') {
        throw new Error('PLATFORM_SECRET_NOT_READABLE');
      }
    }
    return parsed as PlatformProviderKeyVaults;
  };
}
