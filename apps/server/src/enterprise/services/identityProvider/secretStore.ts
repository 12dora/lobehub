import { createHash, randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { PlatformRevisionConflictError } from '@/database/models/platform';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';

export interface StoredIdentityProviderSecret {
  configured: true;
  fingerprint: string;
  revision: number;
  updatedAt: Date;
}

export interface ClearedIdentityProviderSecret {
  configured: false;
  fingerprint: null;
  revision: number;
  updatedAt: null;
}

const fingerprintClientSecret = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/** Database-backed SecretRef store. Public methods never return refs or ciphertext. */
export class IdentityProviderSecretStore {
  constructor(
    private readonly db: LobeChatDatabase | Transaction,
    private readonly secrets: PlatformSecretService,
  ) {}

  private readonly inTransaction = async <T>(callback: (tx: Transaction) => Promise<T>) => {
    const database = this.db as LobeChatDatabase;
    return typeof database.transaction === 'function'
      ? database.transaction(callback)
      : callback(this.db as Transaction);
  };

  persistClientSecret = async (input: {
    expectedRevision: number;
    providerId: string;
    value: string;
  }): Promise<StoredIdentityProviderSecret> => {
    const { expectedRevision, providerId, value } = input;
    if (!value || Buffer.byteLength(value, 'utf8') > 32_768) {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_INVALID');
    }
    const fingerprint = fingerprintClientSecret(value);
    return this.inTransaction(async (tx) => {
      const [provider] = await tx
        .select({
          migrationRequired: platformIdentityProviders.migrationRequired,
          revision: platformIdentityProviders.revision,
        })
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.id, providerId))
        .for('update');
      if (!provider) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
      if (provider.revision !== expectedRevision) {
        throw new PlatformRevisionConflictError('Identity provider revision changed', {
          currentRevision: provider.revision,
          expectedRevision,
          resourceId: providerId,
          resourceType: 'identity_provider',
        });
      }
      if (provider.migrationRequired) {
        throw new Error('PLATFORM_IDENTITY_PROVIDER_MIGRATION_REQUIRED');
      }

      const ciphertext = await this.secrets.encrypt(value);
      const keyId = this.secrets.peekKeyId(ciphertext);
      const updatedAt = new Date();
      const [existing] = await tx
        .select({
          id: platformIdentityProviderSecrets.id,
          ref: platformIdentityProviderSecrets.ref,
        })
        .from(platformIdentityProviderSecrets)
        .where(
          and(
            eq(platformIdentityProviderSecrets.providerId, providerId),
            eq(platformIdentityProviderSecrets.fingerprint, fingerprint),
          ),
        )
        .for('update');
      const ref =
        existing?.ref ?? `kms://platform-identity-providers/${providerId}/${randomUUID()}`;
      if (existing) {
        await tx
          .update(platformIdentityProviderSecrets)
          .set({
            ciphertext,
            keyId,
            revokedAt: null,
            revision: sql`${platformIdentityProviderSecrets.revision} + 1`,
          })
          .where(eq(platformIdentityProviderSecrets.id, existing.id));
      } else {
        await tx.insert(platformIdentityProviderSecrets).values({
          ciphertext,
          createdAt: updatedAt,
          fingerprint,
          keyId,
          providerId,
          ref,
        });
      }
      const nextRevision = expectedRevision + 1;
      const [updated] = await tx
        .update(platformIdentityProviders)
        .set({
          activationRevision: null,
          revision: nextRevision,
          secretFingerprint: fingerprint,
          secretRef: ref,
          secretUpdatedAt: updatedAt,
          status: 'draft',
        })
        .where(
          and(
            eq(platformIdentityProviders.id, providerId),
            eq(platformIdentityProviders.revision, expectedRevision),
          ),
        )
        .returning({ id: platformIdentityProviders.id });
      if (!updated) throw new PlatformRevisionConflictError();
      return { configured: true, fingerprint, revision: nextRevision, updatedAt };
    });
  };

  clearCurrentClientSecret = async (input: {
    expectedRevision: number;
    providerId: string;
  }): Promise<ClearedIdentityProviderSecret> => {
    const { expectedRevision, providerId } = input;
    return this.inTransaction(async (tx) => {
      const [provider] = await tx
        .select({ revision: platformIdentityProviders.revision })
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.id, providerId))
        .for('update');
      if (!provider) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
      if (provider.revision !== expectedRevision) {
        throw new PlatformRevisionConflictError('Identity provider revision changed', {
          currentRevision: provider.revision,
          expectedRevision,
          resourceId: providerId,
          resourceType: 'identity_provider',
        });
      }
      const nextRevision = expectedRevision + 1;
      await tx
        .update(platformIdentityProviders)
        .set({
          activationRevision: null,
          revision: nextRevision,
          secretFingerprint: null,
          secretRef: null,
          secretUpdatedAt: null,
          status: 'draft',
        })
        .where(eq(platformIdentityProviders.id, providerId));
      return { configured: false, fingerprint: null, revision: nextRevision, updatedAt: null };
    });
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
    if (!row) return null;
    try {
      return await this.secrets.decrypt(row.ciphertext);
    } catch {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');
    }
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
      .limit(1);
    if (!row) return null;
    try {
      return await this.secrets.decrypt(row.ciphertext);
    } catch {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE');
    }
  };
}
