import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, isNull } from 'drizzle-orm';

import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

export interface StoredIdentityProviderSecret {
  configured: true;
  fingerprint: string;
  updatedAt: Date;
}

const fingerprintClientSecret = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Database-backed SecretRef store. Public methods never return refs or ciphertext. */
export class IdentityProviderSecretStore {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secrets: PlatformSecretService,
  ) {}

  persistClientSecret = async (
    providerId: string,
    value: string,
  ): Promise<StoredIdentityProviderSecret> => {
    if (!value || Buffer.byteLength(value, 'utf8') > 32_768) {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_INVALID');
    }
    const fingerprint = fingerprintClientSecret(value);
    const ciphertext = await this.secrets.encrypt(value);
    const ref = `kms://platform-identity-providers/${providerId}/${randomUUID()}`;
    const updatedAt = new Date();

    const stored = await this.db.transaction(async (tx) => {
      const [provider] = await tx
        .update(platformIdentityProviders)
        .set({ secretFingerprint: fingerprint, secretRef: ref, secretUpdatedAt: updatedAt })
        .where(eq(platformIdentityProviders.id, providerId))
        .returning({ id: platformIdentityProviders.id });
      if (!provider) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');

      const [row] = await tx
        .insert(platformIdentityProviderSecrets)
        .values({
          ciphertext,
          createdAt: updatedAt,
          fingerprint,
          keyId: this.secrets.peekKeyId(ciphertext),
          providerId,
          ref,
        })
        .returning({
          fingerprint: platformIdentityProviderSecrets.fingerprint,
          updatedAt: platformIdentityProviderSecrets.createdAt,
        });
      if (!row) throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_INVALID');
      return row;
    });

    return { configured: true, fingerprint: stored.fingerprint, updatedAt: stored.updatedAt };
  };

  clearCurrentClientSecret = async (providerId: string): Promise<boolean> => {
    const rows = await this.db
      .update(platformIdentityProviders)
      .set({ secretFingerprint: null, secretRef: null, secretUpdatedAt: null })
      .where(eq(platformIdentityProviders.id, providerId))
      .returning({ id: platformIdentityProviders.id });
    return rows.length === 1;
  };

  resolveCurrentClientSecret = async (providerId: string): Promise<string | null> => {
    const [row] = await this.db
      .select({ ciphertext: platformIdentityProviderSecrets.ciphertext })
      .from(platformIdentityProviders)
      .innerJoin(
        platformIdentityProviderSecrets,
        and(
          eq(platformIdentityProviderSecrets.providerId, platformIdentityProviders.id),
          eq(platformIdentityProviderSecrets.ref, platformIdentityProviders.secretRef),
          isNull(platformIdentityProviderSecrets.revokedAt),
        ),
      )
      .where(eq(platformIdentityProviders.id, providerId))
      .limit(1);
    return row ? this.secrets.decrypt(row.ciphertext) : null;
  };

  resolveClientSecretVersion = async (
    providerId: string,
    fingerprint: string,
  ): Promise<string | null> => {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) return null;
    const [row] = await this.db
      .select({ ciphertext: platformIdentityProviderSecrets.ciphertext })
      .from(platformIdentityProviderSecrets)
      .where(
        and(
          eq(platformIdentityProviderSecrets.providerId, providerId),
          eq(platformIdentityProviderSecrets.fingerprint, fingerprint),
          isNull(platformIdentityProviderSecrets.revokedAt),
        ),
      )
      .orderBy(
        desc(platformIdentityProviderSecrets.createdAt),
        desc(platformIdentityProviderSecrets.id),
      )
      .limit(1);
    return row ? this.secrets.decrypt(row.ciphertext) : null;
  };
}
