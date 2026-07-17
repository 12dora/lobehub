import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorSecrets,
  platformUserConnectorBindings,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { PlatformSecretService } from '../../security/secret';
import type {
  ConnectorCatalogSecretStore,
  ConnectorResolvedSecret,
  ConnectorSecretSlot,
  ConnectorStoredSecret,
} from './catalogTypes';
import { PlatformConnectorContractError } from './errors';

const MAX_SECRET_JSON_BYTES = 64 * 1024;
const ORPHAN_GRACE_MS = 15 * 60 * 1000;

const serializeSecret = (value: unknown): string => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_SECRET_JSON_BYTES) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  return serialized;
};

const fingerprintSecret = (serialized: string): string =>
  createHash('sha256').update(serialized).digest('hex');

export interface PlatformConnectorSecretStoreOptions {
  /** Scheduling seam used by the GC worker; never receives refs or secret values. */
  beforeGcAtomicRevoke?: () => Promise<void>;
}

/**
 * Process-independent Connector secret store backed by encrypted PostgreSQL
 * rows. The `kms://` value is only an opaque application handle; all key
 * operations remain inside M13 PlatformSecretService.
 */
export class PlatformConnectorSecretStore implements ConnectorCatalogSecretStore {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secretService: PlatformSecretService,
    private readonly options: PlatformConnectorSecretStoreOptions = {},
  ) {}

  assertReady = async (): Promise<void> => {
    // A real query detects a missing/unmigrated table without mutating state.
    await this.db
      .select({ id: platformConnectorSecrets.id })
      .from(platformConnectorSecrets)
      .limit(1);
    const marker = `connector-readiness:${randomUUID()}`;
    const ciphertext = await this.secretService.encrypt(marker);
    const plaintext = await this.secretService.decrypt(ciphertext);
    if (plaintext !== marker) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
  };

  persistSecret = async (
    params: {
      connectorId: string;
      slot: ConnectorSecretSlot;
      value: unknown;
    },
    transaction?: Transaction,
  ): Promise<ConnectorStoredSecret> => {
    if (!transaction) {
      try {
        await this.garbageCollectOrphanedOAuthSecrets();
      } catch (error) {
        console.error('[connectorSecretStore] opportunistic orphan cleanup failed', {
          errorClass: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
    const serialized = serializeSecret(params.value);
    const fingerprint = fingerprintSecret(serialized);
    const ciphertext = await this.secretService.encrypt(serialized);
    const ref = `kms://platform-connectors/${params.connectorId}/${params.slot}/${randomUUID()}`;
    const [row] = await (transaction ?? this.db)
      .insert(platformConnectorSecrets)
      .values({
        ciphertext,
        connectorId: params.connectorId,
        fingerprint,
        keyId: this.secretService.peekKeyId(ciphertext),
        ref,
        slot: params.slot,
      })
      .returning();
    if (!row) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
    return { fingerprint: row.fingerprint, ref: row.ref, updatedAt: row.createdAt };
  };

  resolveSecretRef = async (params: {
    connectorId: string;
    ref: string;
    slot: ConnectorSecretSlot;
  }): Promise<ConnectorResolvedSecret | null> => {
    const [row] = await this.db
      .select()
      .from(platformConnectorSecrets)
      .where(
        and(
          eq(platformConnectorSecrets.ref, params.ref),
          eq(platformConnectorSecrets.connectorId, params.connectorId),
          eq(platformConnectorSecrets.slot, params.slot),
          isNull(platformConnectorSecrets.revokedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    return this.resolveRow(row);
  };

  resolveSecretVersion = async (params: {
    connectorId: string;
    fingerprint: string;
    slot: ConnectorSecretSlot;
  }): Promise<ConnectorResolvedSecret | null> => {
    const [row] = await this.db
      .select()
      .from(platformConnectorSecrets)
      .where(
        and(
          eq(platformConnectorSecrets.connectorId, params.connectorId),
          eq(platformConnectorSecrets.fingerprint, params.fingerprint),
          eq(platformConnectorSecrets.slot, params.slot),
          isNull(platformConnectorSecrets.revokedAt),
        ),
      )
      .orderBy(desc(platformConnectorSecrets.createdAt), desc(platformConnectorSecrets.id))
      .limit(1);
    if (!row) return null;
    return this.resolveRow(row);
  };

  revokeSecretRef = async (params: {
    connectorId: string;
    ref: string;
    slot: ConnectorSecretSlot;
  }): Promise<void> => {
    await this.db
      .update(platformConnectorSecrets)
      .set({ revokedAt: sql<Date>`CURRENT_TIMESTAMP` })
      .where(
        and(
          eq(platformConnectorSecrets.ref, params.ref),
          eq(platformConnectorSecrets.connectorId, params.connectorId),
          eq(platformConnectorSecrets.slot, params.slot),
          isNull(platformConnectorSecrets.revokedAt),
        ),
      );
  };

  rotateSecretRef = async (params: {
    connectorId: string;
    ref: string;
    slot: ConnectorSecretSlot;
  }): Promise<ConnectorStoredSecret | null> => {
    const [row] = await this.db
      .select()
      .from(platformConnectorSecrets)
      .where(
        and(
          eq(platformConnectorSecrets.ref, params.ref),
          eq(platformConnectorSecrets.connectorId, params.connectorId),
          eq(platformConnectorSecrets.slot, params.slot),
          isNull(platformConnectorSecrets.revokedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    const ciphertext = await this.secretService.rotate(row.ciphertext);
    const [rotated] = await this.db
      .update(platformConnectorSecrets)
      .set({
        ciphertext,
        keyId: this.secretService.peekKeyId(ciphertext),
        revision: row.revision + 1,
      })
      .where(
        and(
          eq(platformConnectorSecrets.id, row.id),
          eq(platformConnectorSecrets.revision, row.revision),
          isNull(platformConnectorSecrets.revokedAt),
        ),
      )
      .returning();
    if (!rotated) return null;
    return {
      fingerprint: rotated.fingerprint,
      ref: rotated.ref,
      updatedAt: rotated.createdAt,
    };
  };

  loadCurrentSecretSources = async (connectorId: string) => {
    const [connector] = await this.db
      .select({
        oauthClientSecretRef: platformConnectors.oauthClientSecretRef,
        sharedSecretRef: platformConnectors.sharedSecretRef,
      })
      .from(platformConnectors)
      .where(eq(platformConnectors.id, connectorId))
      .limit(1);
    const [oauth, shared] = await Promise.all([
      connector?.oauthClientSecretRef
        ? this.resolveSecretRef({
            connectorId,
            ref: connector.oauthClientSecretRef,
            slot: 'oauthClientSecret',
          })
        : null,
      connector?.sharedSecretRef
        ? this.resolveSecretRef({
            connectorId,
            ref: connector.sharedSecretRef,
            slot: 'sharedSecret',
          })
        : null,
    ]);
    return { oauthClientSecret: oauth?.value, sharedSecret: shared?.value };
  };

  /**
   * Retry path for a bounded cleanup that lost its DB/network race. Only
   * terminal OAuth/PKCE handles older than the grace window are collected;
   * platform client/shared secret versions remain available for rollback.
   */
  garbageCollectOrphanedOAuthSecrets = async (limit = 100): Promise<number> => {
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS);
    const candidates = await this.db
      .select({
        connectorId: platformConnectorSecrets.connectorId,
        id: platformConnectorSecrets.id,
        ref: platformConnectorSecrets.ref,
        slot: platformConnectorSecrets.slot,
      })
      .from(platformConnectorSecrets)
      .where(
        and(
          inArray(platformConnectorSecrets.slot, ['oauthBindingToken', 'oauthPkceVerifier']),
          isNull(platformConnectorSecrets.revokedAt),
          lt(platformConnectorSecrets.createdAt, cutoff),
        ),
      )
      .orderBy(platformConnectorSecrets.createdAt, platformConnectorSecrets.id)
      .limit(Math.max(1, Math.min(limit, 100)));
    let revoked = 0;
    for (const candidate of candidates) {
      const hasNoLiveReference =
        candidate.slot === 'oauthBindingToken'
          ? sql`NOT EXISTS (
              SELECT 1 FROM ${platformUserConnectorBindings}
              WHERE ${platformUserConnectorBindings.connectorId} = ${platformConnectorSecrets.connectorId}
                AND ${platformUserConnectorBindings.oauthTokenRef} = ${platformConnectorSecrets.ref}
                AND ${platformUserConnectorBindings.revokedAt} IS NULL
            )`
          : sql`NOT EXISTS (
              SELECT 1 FROM ${platformConnectorOAuthStates}
              WHERE ${platformConnectorOAuthStates.connectorId} = ${platformConnectorSecrets.connectorId}
                AND ${platformConnectorOAuthStates.pkceVerifierRef} = ${platformConnectorSecrets.ref}
                AND ${platformConnectorOAuthStates.revokedAt} IS NULL
              AND ${platformConnectorOAuthStates.expiresAt} > CURRENT_TIMESTAMP
            )`;
      await this.options.beforeGcAtomicRevoke?.();
      const result = await this.db.transaction(async (db) => {
        const [locked] = await db
          .select({ id: platformConnectorSecrets.id })
          .from(platformConnectorSecrets)
          .where(
            and(
              eq(platformConnectorSecrets.id, candidate.id),
              eq(platformConnectorSecrets.connectorId, candidate.connectorId),
              eq(platformConnectorSecrets.ref, candidate.ref),
              eq(platformConnectorSecrets.slot, candidate.slot),
              isNull(platformConnectorSecrets.revokedAt),
              lt(platformConnectorSecrets.createdAt, cutoff),
            ),
          )
          .limit(1)
          .for('update');
        if (!locked) return [];
        return db
          .update(platformConnectorSecrets)
          .set({ revokedAt: sql<Date>`CURRENT_TIMESTAMP` })
          .where(
            and(
              eq(platformConnectorSecrets.id, candidate.id),
              eq(platformConnectorSecrets.connectorId, candidate.connectorId),
              eq(platformConnectorSecrets.ref, candidate.ref),
              eq(platformConnectorSecrets.slot, candidate.slot),
              isNull(platformConnectorSecrets.revokedAt),
              lt(platformConnectorSecrets.createdAt, cutoff),
              hasNoLiveReference,
            ),
          )
          .returning({ id: platformConnectorSecrets.id });
      });
      revoked += result.length;
    }
    return revoked;
  };

  private resolveRow = async (row: typeof platformConnectorSecrets.$inferSelect) => {
    try {
      const plaintext = await this.secretService.decrypt(row.ciphertext);
      if (fingerprintSecret(plaintext) !== row.fingerprint) {
        throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
      }
      return {
        fingerprint: row.fingerprint,
        ref: row.ref,
        updatedAt: row.createdAt,
        value: JSON.parse(plaintext) as unknown,
      };
    } catch {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
  };
}
