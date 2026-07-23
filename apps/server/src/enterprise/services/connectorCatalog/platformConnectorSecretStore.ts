import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

import debug from 'debug';
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';

import {
  platformConnectorOAuthStates,
  platformConnectors,
  platformConnectorSecrets,
  platformResourceRevisions,
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

const log = debug('lobe-server:connector-secret-store');

const MAX_SECRET_JSON_BYTES = 64 * 1024;
const ORPHAN_GRACE_MS = 15 * 60 * 1000;

/**
 * Versioned integrity keys for the private ciphertext MAC.
 * New writes use CURRENT_INTEGRITY_KID; verification accepts any known kid so
 * rotating PLATFORM_CONNECTOR_SECRET_INTEGRITY_PEPPER_V* does not mass-invalidate
 * existing rows (add a new kid rather than overwriting an old pepper).
 */
const CURRENT_INTEGRITY_KID = 'v1';
const integrityKeyForKid = (kid: string): string | null => {
  if (kid === 'v1') {
    return (
      process.env.PLATFORM_CONNECTOR_SECRET_INTEGRITY_PEPPER_V1 ??
      process.env.PLATFORM_CONNECTOR_SECRET_INTEGRITY_PEPPER ??
      'platform.connector-secret.v1.integrity'
    );
  }
  return null;
};

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

/**
 * Opaque, non-deterministic secret version identifier.
 *
 * Never derive this from secret bytes: raw SHA-256 of predictable JSON is an
 * offline guessing oracle when fingerprints are exposed in admin projections
 * and audit summaries. Public fingerprint is a random version id; integrity is
 * a private keyed MAC bound into the encrypted payload (and legacy rows fall
 * back to content-hash matching the historical deterministic fingerprint).
 */
const fingerprintSecret = (_serialized: string): string => randomBytes(32).toString('hex');

/** Private integrity MAC bound to the public version id + plaintext body. */
const integrityMac = (kid: string, fingerprint: string, serialized: string): string => {
  const key = integrityKeyForKid(kid);
  if (!key) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  return createHmac('sha256', key).update(`${kid}\0${fingerprint}\0${serialized}`).digest('hex');
};

/** Seal plaintext so ciphertext cannot be swapped without the integrity pepper. */
const sealSecretPayload = (fingerprint: string, serialized: string): string =>
  JSON.stringify({
    body: serialized,
    kid: CURRENT_INTEGRITY_KID,
    mac: integrityMac(CURRENT_INTEGRITY_KID, fingerprint, serialized),
    v: 2,
  });

/**
 * Open sealed or legacy payloads. Rejects ciphertext that decrypts but does not
 * match the row fingerprint / integrity MAC (substitution / tamper).
 */
const openSecretPayload = (fingerprint: string, plaintext: string): string => {
  try {
    const parsed = JSON.parse(plaintext) as {
      body?: unknown;
      kid?: unknown;
      mac?: unknown;
      v?: unknown;
    };
    if (
      parsed &&
      parsed.v === 2 &&
      typeof parsed.body === 'string' &&
      typeof parsed.mac === 'string'
    ) {
      // Pre-kid rows used an unversioned MAC; accept kid-less as CURRENT.
      const kid =
        typeof parsed.kid === 'string' && parsed.kid.length > 0
          ? parsed.kid
          : CURRENT_INTEGRITY_KID;
      const expectedWithKid = integrityMac(kid, fingerprint, parsed.body);
      if (parsed.mac === expectedWithKid) return parsed.body;
      // Legacy v2 seal without kid prefix in the MAC material.
      if (typeof parsed.kid !== 'string') {
        const key = integrityKeyForKid(CURRENT_INTEGRITY_KID);
        if (key) {
          const legacyMac = createHmac('sha256', key)
            .update(`${fingerprint}\0${parsed.body}`)
            .digest('hex');
          if (parsed.mac === legacyMac) return parsed.body;
        }
      }
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
  } catch (error) {
    if (error instanceof PlatformConnectorContractError) throw error;
    // Fall through to legacy raw JSON handling.
  }
  // Legacy rows stored raw secret JSON with deterministic SHA-256 fingerprints.
  const legacyFingerprint = createHash('sha256').update(plaintext).digest('hex');
  if (legacyFingerprint !== fingerprint) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  return plaintext;
};

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
        await this.garbageCollectOrphanedSecrets();
      } catch (error) {
        log(
          'opportunistic orphan cleanup failed errorClass=%s',
          error instanceof Error ? error.name : 'UnknownError',
        );
      }
    }
    const serialized = serializeSecret(params.value);
    const fingerprint = fingerprintSecret(serialized);
    const ciphertext = await this.secretService.encrypt(sealSecretPayload(fingerprint, serialized));
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
   * Retry path for orphaned secret handles older than the grace window.
   * Covers OAuth/PKCE binding secrets and unreachable client/shared secrets
   * that lost CAS before any connector row referenced them.
   */
  garbageCollectOrphanedSecrets = async (limit = 100): Promise<number> => {
    const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS);
    const candidates = await this.db
      .select({
        connectorId: platformConnectorSecrets.connectorId,
        fingerprint: platformConnectorSecrets.fingerprint,
        id: platformConnectorSecrets.id,
        ref: platformConnectorSecrets.ref,
        slot: platformConnectorSecrets.slot,
      })
      .from(platformConnectorSecrets)
      .where(
        and(
          inArray(platformConnectorSecrets.slot, [
            'oauthBindingToken',
            'oauthPkceVerifier',
            'oauthClientSecret',
            'sharedSecret',
          ]),
          isNull(platformConnectorSecrets.revokedAt),
          lt(platformConnectorSecrets.createdAt, cutoff),
        ),
      )
      .orderBy(platformConnectorSecrets.createdAt, platformConnectorSecrets.id)
      .limit(Math.max(1, Math.min(limit, 100)));
    let revoked = 0;
    for (const candidate of candidates) {
      // Client/shared secrets may still be required by published revision
      // snapshots (rollback / historical runtime). Never revoke when any
      // immutable revision payload still references the fingerprint.
      const hasNoLiveReference =
        candidate.slot === 'oauthBindingToken'
          ? sql`NOT EXISTS (
              SELECT 1 FROM ${platformUserConnectorBindings}
              WHERE ${platformUserConnectorBindings.connectorId} = ${platformConnectorSecrets.connectorId}
                AND ${platformUserConnectorBindings.oauthTokenRef} = ${platformConnectorSecrets.ref}
                AND ${platformUserConnectorBindings.revokedAt} IS NULL
            )`
          : candidate.slot === 'oauthPkceVerifier'
            ? sql`NOT EXISTS (
              SELECT 1 FROM ${platformConnectorOAuthStates}
              WHERE ${platformConnectorOAuthStates.connectorId} = ${platformConnectorSecrets.connectorId}
                AND ${platformConnectorOAuthStates.pkceVerifierRef} = ${platformConnectorSecrets.ref}
                AND ${platformConnectorOAuthStates.revokedAt} IS NULL
              AND ${platformConnectorOAuthStates.expiresAt} > CURRENT_TIMESTAMP
            )`
            : candidate.slot === 'oauthClientSecret'
              ? sql`(
              NOT EXISTS (
                SELECT 1 FROM ${platformConnectors}
                WHERE ${platformConnectors.id} = ${platformConnectorSecrets.connectorId}
                  AND ${platformConnectors.oauthClientSecretRef} = ${platformConnectorSecrets.ref}
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${platformResourceRevisions}
                WHERE ${platformResourceRevisions.resourceType} = 'connector'
                  AND ${platformResourceRevisions.resourceId} = ${platformConnectorSecrets.connectorId}
                  AND (
                    ${platformResourceRevisions.payload} #>> '{connector,oauthClientSecretFingerprint}'
                      = ${platformConnectorSecrets.fingerprint}
                    OR ${platformResourceRevisions.payload} #>> '{connector,sharedSecretFingerprint}'
                      = ${platformConnectorSecrets.fingerprint}
                  )
              )
            )`
              : sql`(
              NOT EXISTS (
                SELECT 1 FROM ${platformConnectors}
                WHERE ${platformConnectors.id} = ${platformConnectorSecrets.connectorId}
                  AND ${platformConnectors.sharedSecretRef} = ${platformConnectorSecrets.ref}
              )
              AND NOT EXISTS (
                SELECT 1 FROM ${platformResourceRevisions}
                WHERE ${platformResourceRevisions.resourceType} = 'connector'
                  AND ${platformResourceRevisions.resourceId} = ${platformConnectorSecrets.connectorId}
                  AND (
                    ${platformResourceRevisions.payload} #>> '{connector,oauthClientSecretFingerprint}'
                      = ${platformConnectorSecrets.fingerprint}
                    OR ${platformResourceRevisions.payload} #>> '{connector,sharedSecretFingerprint}'
                      = ${platformConnectorSecrets.fingerprint}
                  )
              )
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

  /** @deprecated Prefer garbageCollectOrphanedSecrets (covers client/shared too). */
  garbageCollectOrphanedOAuthSecrets = async (limit = 100): Promise<number> =>
    this.garbageCollectOrphanedSecrets(limit);

  private resolveRow = async (row: typeof platformConnectorSecrets.$inferSelect) => {
    try {
      const plaintext = await this.secretService.decrypt(row.ciphertext);
      const body = openSecretPayload(row.fingerprint, plaintext);
      return {
        fingerprint: row.fingerprint,
        ref: row.ref,
        updatedAt: row.createdAt,
        value: JSON.parse(body) as unknown,
      };
    } catch (error) {
      if (error instanceof PlatformConnectorContractError) throw error;
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
  };
}
