import { and, type AnyColumn, asc, eq, gt, isNotNull, isNull, ne, or } from 'drizzle-orm';

import {
  platformAiProviders,
  platformAiProviderSecrets,
  platformConnectorSecrets,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PLATFORM_SECRET_ROTATION_DOMAINS,
  type PlatformSecretRotationCandidate,
  type PlatformSecretRotationCasResult,
  type PlatformSecretRotationCursor,
  type PlatformSecretRotationDomain,
  type PlatformSecretRotationPage,
} from './types';

export * from './types';

const MAX_PAGE_SIZE = 50;

interface CandidateValues {
  ciphertext: string;
  domain: PlatformSecretRotationDomain;
  fingerprint?: string | null;
  id: string;
  ownerId?: string | null;
  revision?: number | null;
  storedKeyId: string | null;
}

/** Private fields make console inspection and JSON.stringify emit no secret material. */
class InternalRotationCandidate implements PlatformSecretRotationCandidate {
  readonly #ciphertext: string;
  readonly #domain: PlatformSecretRotationDomain;
  readonly #fingerprint: string | null;
  readonly #id: string;
  readonly #ownerId: string | null;
  readonly #revision: number | null;
  readonly #storedKeyId: string | null;

  constructor(values: CandidateValues) {
    this.#ciphertext = values.ciphertext;
    this.#domain = values.domain;
    this.#fingerprint = values.fingerprint ?? null;
    this.#id = values.id;
    this.#ownerId = values.ownerId ?? null;
    this.#revision = values.revision ?? null;
    this.#storedKeyId = values.storedKeyId;
  }

  get ciphertext() {
    return this.#ciphertext;
  }

  get domain() {
    return this.#domain;
  }

  get fingerprint() {
    return this.#fingerprint;
  }

  get id() {
    return this.#id;
  }

  get ownerId() {
    return this.#ownerId;
  }

  get revision() {
    return this.#revision;
  }

  get storedKeyId() {
    return this.#storedKeyId;
  }
}

const keyIdCondition = (column: AnyColumn, storedKeyId: string | null) =>
  storedKeyId === null ? isNull(column) : eq(column, storedKeyId);

/**
 * Persistence-only foundation for bounded, resumable secret re-wrap.
 *
 * This repository deliberately does not decrypt, persist job cursors, emit
 * audit records, or update runtime/LKG state. In particular, an OIDC secret
 * CAS does not authorize an LKG reload: the future orchestrator must pass the
 * external OIDC last-known-good health gate before changing runtime state.
 */
export class PlatformSecretRotationRepository {
  constructor(private readonly db: LobeChatDatabase) {}

  private listDomain = async (params: {
    afterId?: string;
    domain: PlatformSecretRotationDomain;
    limit: number;
    targetKeyId: string;
  }): Promise<PlatformSecretRotationCandidate[]> => {
    const { afterId, domain, limit, targetKeyId } = params;

    switch (domain) {
      case 'aiCurrent': {
        const rows = await this.db
          .select({
            ciphertext: platformAiProviders.encryptedKeyVaults,
            fingerprint: platformAiProviders.secretFingerprint,
            id: platformAiProviders.id,
            revision: platformAiProviders.secretKeyVersion,
            storedKeyId: platformAiProviders.secretKeyId,
          })
          .from(platformAiProviders)
          .where(
            and(
              isNotNull(platformAiProviders.encryptedKeyVaults),
              or(
                isNull(platformAiProviders.secretKeyId),
                ne(platformAiProviders.secretKeyId, targetKeyId),
              ),
              afterId ? gt(platformAiProviders.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(platformAiProviders.id))
          .limit(limit);
        return rows.map(
          (row) =>
            new InternalRotationCandidate({
              ...row,
              ciphertext: row.ciphertext!,
              domain,
            }),
        );
      }
      case 'aiImmutable': {
        const rows = await this.db
          .select({
            ciphertext: platformAiProviderSecrets.ciphertext,
            fingerprint: platformAiProviderSecrets.fingerprint,
            id: platformAiProviderSecrets.id,
            ownerId: platformAiProviderSecrets.providerId,
            revision: platformAiProviderSecrets.keyVersion,
            storedKeyId: platformAiProviderSecrets.keyId,
          })
          .from(platformAiProviderSecrets)
          .where(
            and(
              or(
                isNull(platformAiProviderSecrets.keyId),
                ne(platformAiProviderSecrets.keyId, targetKeyId),
              ),
              afterId ? gt(platformAiProviderSecrets.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(platformAiProviderSecrets.id))
          .limit(limit);
        return rows.map((row) => new InternalRotationCandidate({ ...row, domain }));
      }
      case 'connector': {
        const rows = await this.db
          .select({
            ciphertext: platformConnectorSecrets.ciphertext,
            id: platformConnectorSecrets.id,
            ownerId: platformConnectorSecrets.connectorId,
            revision: platformConnectorSecrets.revision,
            storedKeyId: platformConnectorSecrets.keyId,
          })
          .from(platformConnectorSecrets)
          .where(
            and(
              ne(platformConnectorSecrets.keyId, targetKeyId),
              afterId ? gt(platformConnectorSecrets.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(platformConnectorSecrets.id))
          .limit(limit);
        return rows.map((row) => new InternalRotationCandidate({ ...row, domain }));
      }
      case 'identityProvider': {
        const rows = await this.db
          .select({
            ciphertext: platformIdentityProviderSecrets.ciphertext,
            fingerprint: platformIdentityProviderSecrets.fingerprint,
            id: platformIdentityProviderSecrets.id,
            ownerId: platformIdentityProviderSecrets.providerId,
            revision: platformIdentityProviderSecrets.revision,
            storedKeyId: platformIdentityProviderSecrets.keyId,
          })
          .from(platformIdentityProviderSecrets)
          .where(
            and(
              ne(platformIdentityProviderSecrets.keyId, targetKeyId),
              afterId ? gt(platformIdentityProviderSecrets.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(platformIdentityProviderSecrets.id))
          .limit(limit);
        return rows.map((row) => new InternalRotationCandidate({ ...row, domain }));
      }
      case 'identityProviderTestPkce': {
        const rows = await this.db
          .select({
            ciphertext: platformIdentityProviderTestAttempts.pkceCiphertext,
            id: platformIdentityProviderTestAttempts.id,
            ownerId: platformIdentityProviderTestAttempts.providerId,
            storedKeyId: platformIdentityProviderTestAttempts.pkceKeyId,
          })
          .from(platformIdentityProviderTestAttempts)
          .where(
            and(
              ne(platformIdentityProviderTestAttempts.pkceKeyId, targetKeyId),
              afterId ? gt(platformIdentityProviderTestAttempts.id, afterId) : undefined,
            ),
          )
          .orderBy(asc(platformIdentityProviderTestAttempts.id))
          .limit(limit);
        return rows.map((row) => new InternalRotationCandidate({ ...row, domain }));
      }
    }
  };

  listCandidates = async (params: {
    cursor?: PlatformSecretRotationCursor;
    limit?: number;
    targetKeyId: string;
  }): Promise<PlatformSecretRotationPage> => {
    const limit = Math.min(Math.max(params.limit ?? MAX_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const startIndex = params.cursor
      ? PLATFORM_SECRET_ROTATION_DOMAINS.indexOf(params.cursor.domain)
      : 0;
    if (startIndex < 0) return { items: [], nextCursor: null };

    const candidates: PlatformSecretRotationCandidate[] = [];
    for (let index = startIndex; index < PLATFORM_SECRET_ROTATION_DOMAINS.length; index += 1) {
      const domain = PLATFORM_SECRET_ROTATION_DOMAINS[index]!;
      const rows = await this.listDomain({
        afterId: index === startIndex ? params.cursor?.id : undefined,
        domain,
        limit: limit + 1 - candidates.length,
        targetKeyId: params.targetKeyId,
      });
      candidates.push(...rows);
      if (candidates.length > limit) break;
    }

    const items = candidates.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: candidates.length > limit && last ? { domain: last.domain, id: last.id } : null,
    };
  };

  rotateExact = async (params: {
    candidate: PlatformSecretRotationCandidate;
    ciphertext: string;
    targetKeyId: string;
  }): Promise<PlatformSecretRotationCasResult> => {
    const { candidate, ciphertext, targetKeyId } = params;
    const noCurrent = { currentSynchronized: false, updated: false };

    switch (candidate.domain) {
      case 'aiCurrent': {
        const rows = await this.db
          .update(platformAiProviders)
          .set({ encryptedKeyVaults: ciphertext, secretKeyId: targetKeyId })
          .where(
            and(
              eq(platformAiProviders.id, candidate.id),
              eq(platformAiProviders.encryptedKeyVaults, candidate.ciphertext),
              candidate.revision === null
                ? isNull(platformAiProviders.secretKeyVersion)
                : eq(platformAiProviders.secretKeyVersion, candidate.revision),
            ),
          )
          .returning({ id: platformAiProviders.id });
        return { currentSynchronized: false, updated: rows.length === 1 };
      }
      case 'aiImmutable': {
        if (candidate.revision === null) return noCurrent;
        const revision = candidate.revision;
        return this.db.transaction(async (tx) => {
          const immutable = await tx
            .update(platformAiProviderSecrets)
            .set({ ciphertext, keyId: targetKeyId })
            .where(
              and(
                eq(platformAiProviderSecrets.id, candidate.id),
                eq(platformAiProviderSecrets.ciphertext, candidate.ciphertext),
                eq(platformAiProviderSecrets.keyVersion, revision),
              ),
            )
            .returning({ id: platformAiProviderSecrets.id });
          if (immutable.length !== 1) return noCurrent;
          if (!candidate.ownerId || !candidate.fingerprint) {
            return { currentSynchronized: false, updated: true };
          }

          const current = await tx
            .update(platformAiProviders)
            .set({ encryptedKeyVaults: ciphertext, secretKeyId: targetKeyId })
            .where(
              and(
                eq(platformAiProviders.id, candidate.ownerId),
                eq(platformAiProviders.secretFingerprint, candidate.fingerprint),
                eq(platformAiProviders.encryptedKeyVaults, candidate.ciphertext),
                eq(platformAiProviders.secretKeyVersion, revision),
              ),
            )
            .returning({ id: platformAiProviders.id });
          return { currentSynchronized: current.length === 1, updated: true };
        });
      }
      case 'connector': {
        if (candidate.revision === null) return noCurrent;
        const rows = await this.db
          .update(platformConnectorSecrets)
          .set({ ciphertext, keyId: targetKeyId })
          .where(
            and(
              eq(platformConnectorSecrets.id, candidate.id),
              eq(platformConnectorSecrets.ciphertext, candidate.ciphertext),
              keyIdCondition(platformConnectorSecrets.keyId, candidate.storedKeyId),
              eq(platformConnectorSecrets.revision, candidate.revision),
            ),
          )
          .returning({ id: platformConnectorSecrets.id });
        return { currentSynchronized: false, updated: rows.length === 1 };
      }
      case 'identityProvider': {
        if (candidate.revision === null) return noCurrent;
        const rows = await this.db
          .update(platformIdentityProviderSecrets)
          .set({ ciphertext, keyId: targetKeyId })
          .where(
            and(
              eq(platformIdentityProviderSecrets.id, candidate.id),
              eq(platformIdentityProviderSecrets.ciphertext, candidate.ciphertext),
              keyIdCondition(platformIdentityProviderSecrets.keyId, candidate.storedKeyId),
              eq(platformIdentityProviderSecrets.revision, candidate.revision),
            ),
          )
          .returning({ id: platformIdentityProviderSecrets.id });
        return { currentSynchronized: false, updated: rows.length === 1 };
      }
      case 'identityProviderTestPkce': {
        const rows = await this.db
          .update(platformIdentityProviderTestAttempts)
          .set({ pkceCiphertext: ciphertext, pkceKeyId: targetKeyId })
          .where(
            and(
              eq(platformIdentityProviderTestAttempts.id, candidate.id),
              eq(platformIdentityProviderTestAttempts.pkceCiphertext, candidate.ciphertext),
              keyIdCondition(platformIdentityProviderTestAttempts.pkceKeyId, candidate.storedKeyId),
            ),
          )
          .returning({ id: platformIdentityProviderTestAttempts.id });
        return { currentSynchronized: false, updated: rows.length === 1 };
      }
    }
  };
}
