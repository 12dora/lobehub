import { and, asc, eq, gt, isNotNull, isNull, ne, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable, SelectedFields } from 'drizzle-orm/pg-core';

import {
  platformAiProviders,
  platformAiProviderSecrets,
  platformConnectorSecrets,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
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

type Db = LobeChatDatabase | Transaction;

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

const keyIdCondition = (column: AnyPgColumn, storedKeyId: string | null) =>
  storedKeyId === null ? isNull(column) : eq(column, storedKeyId);

const NO_CURRENT: PlatformSecretRotationCasResult = {
  currentSynchronized: false,
  updated: false,
};

/**
 * Per-domain column source-of-truth. Select projections, list filters, and CAS
 * predicates all read from these column refs so domain schema drift is edited once.
 */
interface DomainColumns {
  ciphertext: AnyPgColumn;
  fingerprint?: AnyPgColumn;
  id: AnyPgColumn;
  ownerId?: AnyPgColumn;
  revision?: AnyPgColumn;
  storedKeyId: AnyPgColumn;
}

interface SelectRow {
  ciphertext: string | null;
  fingerprint?: string | null;
  id: string;
  ownerId?: string | null;
  revision?: number | null;
  storedKeyId: string | null;
}

/** Project a Drizzle partial-select row (keys from DomainColumns) into SelectRow. */
const projectSelectRow = (row: Record<string, unknown>): SelectRow => {
  const id = row.id;
  const ciphertext = row.ciphertext;
  const storedKeyId = row.storedKeyId;
  if (typeof id !== 'string') {
    throw new TypeError('platform secret rotation select row missing string id');
  }
  if (ciphertext !== null && typeof ciphertext !== 'string') {
    throw new TypeError('platform secret rotation select row invalid ciphertext');
  }
  if (storedKeyId !== null && typeof storedKeyId !== 'string') {
    throw new TypeError('platform secret rotation select row invalid storedKeyId');
  }

  const projected: SelectRow = { ciphertext, id, storedKeyId };

  if ('fingerprint' in row) {
    const fingerprint = row.fingerprint;
    if (fingerprint !== null && fingerprint !== undefined && typeof fingerprint !== 'string') {
      throw new TypeError('platform secret rotation select row invalid fingerprint');
    }
    projected.fingerprint = fingerprint ?? null;
  }
  if ('ownerId' in row) {
    const ownerId = row.ownerId;
    if (ownerId !== null && ownerId !== undefined && typeof ownerId !== 'string') {
      throw new TypeError('platform secret rotation select row invalid ownerId');
    }
    projected.ownerId = ownerId ?? null;
  }
  if ('revision' in row) {
    const revision = row.revision;
    if (revision !== null && revision !== undefined && typeof revision !== 'number') {
      throw new TypeError('platform secret rotation select row invalid revision');
    }
    projected.revision = revision ?? null;
  }

  return projected;
};

interface ListDomainParams {
  afterId?: string;
  limit: number;
  targetKeyId: string;
}

interface RotateExactParams {
  candidate: PlatformSecretRotationCandidate;
  ciphertext: string;
  targetKeyId: string;
}

interface RotateExactContext {
  db: Db;
  transactionScoped: boolean;
}

/**
 * Typed domain handler. Drizzle cannot safely unify heterogeneous tables into one
 * generic update/select builder, so each domain owns a small handler while sharing
 * column maps + query helpers below. No `any`.
 */
interface DomainRotationHandler {
  readonly domain: PlatformSecretRotationDomain;
  getById: (db: Db, id: string) => Promise<PlatformSecretRotationCandidate | undefined>;
  listDomain: (db: Db, params: ListDomainParams) => Promise<PlatformSecretRotationCandidate[]>;
  rotateExact: (
    ctx: RotateExactContext,
    params: RotateExactParams,
  ) => Promise<PlatformSecretRotationCasResult>;
}

const candidateSelect = (columns: DomainColumns): SelectedFields => {
  const projection: SelectedFields = {
    ciphertext: columns.ciphertext,
    id: columns.id,
    storedKeyId: columns.storedKeyId,
  };
  if (columns.fingerprint) projection.fingerprint = columns.fingerprint;
  if (columns.ownerId) projection.ownerId = columns.ownerId;
  if (columns.revision) projection.revision = columns.revision;
  return projection;
};

const toCandidate = (
  domain: PlatformSecretRotationDomain,
  row: SelectRow,
): InternalRotationCandidate => {
  if (row.ciphertext === null) {
    throw new TypeError('platform secret rotation candidate requires ciphertext');
  }
  return new InternalRotationCandidate({
    ciphertext: row.ciphertext,
    domain,
    fingerprint: row.fingerprint,
    id: row.id,
    ownerId: row.ownerId,
    revision: row.revision,
    storedKeyId: row.storedKeyId,
  });
};

const listKeyMismatch = (
  storedKeyId: AnyPgColumn,
  targetKeyId: string,
  mode: 'notEqual' | 'nullOrNotEqual',
): SQL =>
  mode === 'nullOrNotEqual'
    ? (or(isNull(storedKeyId), ne(storedKeyId, targetKeyId)) as SQL)
    : (ne(storedKeyId, targetKeyId) as SQL);

const listDomainWhere = (params: {
  afterId?: string;
  columns: DomainColumns;
  keyMode: 'notEqual' | 'nullOrNotEqual';
  requireCiphertext: boolean;
  targetKeyId: string;
}) =>
  and(
    params.requireCiphertext ? isNotNull(params.columns.ciphertext) : undefined,
    listKeyMismatch(params.columns.storedKeyId, params.targetKeyId, params.keyMode),
    params.afterId ? gt(params.columns.id, params.afterId) : undefined,
  );

const getByIdWhere = (columns: DomainColumns, id: string, requireCiphertext: boolean) =>
  and(eq(columns.id, id), requireCiphertext ? isNotNull(columns.ciphertext) : undefined);

/**
 * Shared read path: one select projection + filters driven by DomainColumns.
 * `table` stays untyped at the PgTable boundary because domain tables differ;
 * columns themselves remain the typed source-of-truth for projections/predicates.
 */
const selectCandidates = async (params: {
  columns: DomainColumns;
  db: Db;
  limit?: number;
  table: PgTable;
  where: SQL | undefined;
}): Promise<SelectRow[]> => {
  const query = params.db
    .select(candidateSelect(params.columns))
    .from(params.table)
    .where(params.where)
    .orderBy(asc(params.columns.id));

  // PgTable erases row shape; DomainColumns own the projection contract.
  // Map field-by-field (no whole-row `as SelectRow[]` / `as unknown`).
  const rows = await query.limit(params.limit ?? 1);
  return rows.map((row) => projectSelectRow(row));
};

const casUpdated = async (params: {
  db: Db;
  idColumn: AnyPgColumn;
  set: Record<string, string>;
  table: PgTable;
  where: SQL | undefined;
}): Promise<boolean> => {
  const rows = await params.db
    .update(params.table)
    .set(params.set)
    .where(params.where)
    .returning({ id: params.idColumn });
  return rows.length === 1;
};

const revisionEq = (column: AnyPgColumn, revision: number | null) =>
  revision === null ? isNull(column) : eq(column, revision);

/** Standard inventory domain: list by key mismatch, CAS on ciphertext (+ optional key/revision). */
const createColumnDomainHandler = (config: {
  columns: DomainColumns;
  domain: PlatformSecretRotationDomain;
  keyMode: 'notEqual' | 'nullOrNotEqual';
  requireCiphertext: boolean;
  requireRevision: boolean;
  /**
   * CAS also matches stored key id (connector / identity / pkce).
   * aiCurrent matches revision only; aiImmutable is custom.
   */
  casKeyId: boolean;
  set: (ciphertext: string, targetKeyId: string) => Record<string, string>;
  table: PgTable;
}): DomainRotationHandler => {
  const { columns, domain, table } = config;

  return {
    domain,

    getById: async (db, id) => {
      const [row] = await selectCandidates({
        columns,
        db,
        table,
        where: getByIdWhere(columns, id, config.requireCiphertext),
      });
      return row ? toCandidate(domain, row) : undefined;
    },

    listDomain: async (db, params) => {
      const rows = await selectCandidates({
        columns,
        db,
        limit: params.limit,
        table,
        where: listDomainWhere({
          afterId: params.afterId,
          columns,
          keyMode: config.keyMode,
          requireCiphertext: config.requireCiphertext,
          targetKeyId: params.targetKeyId,
        }),
      });
      return rows.map((row) => toCandidate(domain, row));
    },

    rotateExact: async ({ db }, { candidate, ciphertext, targetKeyId }) => {
      if (config.requireRevision && candidate.revision === null) return NO_CURRENT;

      const where = and(
        eq(columns.id, candidate.id),
        eq(columns.ciphertext, candidate.ciphertext),
        config.casKeyId ? keyIdCondition(columns.storedKeyId, candidate.storedKeyId) : undefined,
        columns.revision ? revisionEq(columns.revision, candidate.revision) : undefined,
      );

      const updated = await casUpdated({
        db,
        idColumn: columns.id,
        set: config.set(ciphertext, targetKeyId),
        table,
        where,
      });
      return { currentSynchronized: false, updated };
    },
  };
};

// ---------------------------------------------------------------------------
// Domain column maps (single source of truth per domain)
// ---------------------------------------------------------------------------

const AI_CURRENT_COLUMNS = {
  ciphertext: platformAiProviders.encryptedKeyVaults,
  fingerprint: platformAiProviders.secretFingerprint,
  id: platformAiProviders.id,
  revision: platformAiProviders.secretKeyVersion,
  storedKeyId: platformAiProviders.secretKeyId,
} as const satisfies DomainColumns;

const AI_IMMUTABLE_COLUMNS = {
  ciphertext: platformAiProviderSecrets.ciphertext,
  fingerprint: platformAiProviderSecrets.fingerprint,
  id: platformAiProviderSecrets.id,
  ownerId: platformAiProviderSecrets.providerId,
  revision: platformAiProviderSecrets.keyVersion,
  storedKeyId: platformAiProviderSecrets.keyId,
} as const satisfies DomainColumns;

const CONNECTOR_COLUMNS = {
  ciphertext: platformConnectorSecrets.ciphertext,
  id: platformConnectorSecrets.id,
  ownerId: platformConnectorSecrets.connectorId,
  revision: platformConnectorSecrets.revision,
  storedKeyId: platformConnectorSecrets.keyId,
} as const satisfies DomainColumns;

const IDENTITY_PROVIDER_COLUMNS = {
  ciphertext: platformIdentityProviderSecrets.ciphertext,
  fingerprint: platformIdentityProviderSecrets.fingerprint,
  id: platformIdentityProviderSecrets.id,
  ownerId: platformIdentityProviderSecrets.providerId,
  revision: platformIdentityProviderSecrets.revision,
  storedKeyId: platformIdentityProviderSecrets.keyId,
} as const satisfies DomainColumns;

const IDENTITY_PROVIDER_TEST_PKCE_COLUMNS = {
  ciphertext: platformIdentityProviderTestAttempts.pkceCiphertext,
  id: platformIdentityProviderTestAttempts.id,
  ownerId: platformIdentityProviderTestAttempts.providerId,
  storedKeyId: platformIdentityProviderTestAttempts.pkceKeyId,
} as const satisfies DomainColumns;

const aiCurrentHandler = createColumnDomainHandler({
  casKeyId: false,
  columns: AI_CURRENT_COLUMNS,
  domain: 'aiCurrent',
  keyMode: 'nullOrNotEqual',
  requireCiphertext: true,
  requireRevision: false,
  set: (ciphertext, targetKeyId) => ({
    encryptedKeyVaults: ciphertext,
    secretKeyId: targetKeyId,
  }),
  table: platformAiProviders,
});

/**
 * AI immutable history: CAS the version row, then best-effort sync the matching
 * current provider material in the same transaction. Column map above still owns
 * inventory projections; dual-write predicates stay explicit here.
 */
const aiImmutableHandler: DomainRotationHandler = {
  domain: 'aiImmutable',

  getById: async (db, id) => {
    const [row] = await selectCandidates({
      columns: AI_IMMUTABLE_COLUMNS,
      db,
      table: platformAiProviderSecrets,
      where: getByIdWhere(AI_IMMUTABLE_COLUMNS, id, false),
    });
    return row ? toCandidate('aiImmutable', row) : undefined;
  },

  listDomain: async (db, params) => {
    const rows = await selectCandidates({
      columns: AI_IMMUTABLE_COLUMNS,
      db,
      limit: params.limit,
      table: platformAiProviderSecrets,
      where: listDomainWhere({
        afterId: params.afterId,
        columns: AI_IMMUTABLE_COLUMNS,
        keyMode: 'nullOrNotEqual',
        requireCiphertext: false,
        targetKeyId: params.targetKeyId,
      }),
    });
    return rows.map((row) => toCandidate('aiImmutable', row));
  },

  rotateExact: async (ctx, { candidate, ciphertext, targetKeyId }) => {
    if (candidate.revision === null) return NO_CURRENT;
    const revision = candidate.revision;
    const columns = AI_IMMUTABLE_COLUMNS;

    const rotate = async (tx: Db): Promise<PlatformSecretRotationCasResult> => {
      const updated = await casUpdated({
        db: tx,
        idColumn: columns.id,
        set: { ciphertext, keyId: targetKeyId },
        table: platformAiProviderSecrets,
        where: and(
          eq(columns.id, candidate.id),
          eq(columns.ciphertext, candidate.ciphertext),
          eq(columns.revision, revision),
        ),
      });
      if (!updated) return NO_CURRENT;
      if (!candidate.ownerId || !candidate.fingerprint) {
        return { currentSynchronized: false, updated: true };
      }

      const currentSynchronized = await casUpdated({
        db: tx,
        idColumn: AI_CURRENT_COLUMNS.id,
        set: {
          encryptedKeyVaults: ciphertext,
          secretKeyId: targetKeyId,
        },
        table: platformAiProviders,
        where: and(
          eq(AI_CURRENT_COLUMNS.id, candidate.ownerId),
          eq(AI_CURRENT_COLUMNS.fingerprint!, candidate.fingerprint),
          eq(AI_CURRENT_COLUMNS.ciphertext, candidate.ciphertext),
          eq(AI_CURRENT_COLUMNS.revision!, revision),
        ),
      });
      return { currentSynchronized, updated: true };
    };

    if (ctx.transactionScoped) return rotate(ctx.db);
    return (ctx.db as LobeChatDatabase).transaction(rotate);
  },
};

const connectorHandler = createColumnDomainHandler({
  casKeyId: true,
  columns: CONNECTOR_COLUMNS,
  domain: 'connector',
  keyMode: 'notEqual',
  requireCiphertext: false,
  requireRevision: true,
  set: (ciphertext, targetKeyId) => ({ ciphertext, keyId: targetKeyId }),
  table: platformConnectorSecrets,
});

const identityProviderHandler = createColumnDomainHandler({
  casKeyId: true,
  columns: IDENTITY_PROVIDER_COLUMNS,
  domain: 'identityProvider',
  keyMode: 'notEqual',
  requireCiphertext: false,
  requireRevision: true,
  set: (ciphertext, targetKeyId) => ({ ciphertext, keyId: targetKeyId }),
  table: platformIdentityProviderSecrets,
});

const identityProviderTestPkceHandler = createColumnDomainHandler({
  casKeyId: true,
  columns: IDENTITY_PROVIDER_TEST_PKCE_COLUMNS,
  domain: 'identityProviderTestPkce',
  keyMode: 'notEqual',
  requireCiphertext: false,
  requireRevision: false,
  set: (ciphertext, targetKeyId) => ({
    pkceCiphertext: ciphertext,
    pkceKeyId: targetKeyId,
  }),
  table: platformIdentityProviderTestAttempts,
});

/**
 * Exhaustive domain registry. Adding a domain forces a new entry here and
 * cannot leave getById/listDomain/rotateExact out of sync.
 */
const DOMAIN_HANDLERS = {
  aiCurrent: aiCurrentHandler,
  aiImmutable: aiImmutableHandler,
  connector: connectorHandler,
  identityProvider: identityProviderHandler,
  identityProviderTestPkce: identityProviderTestPkceHandler,
} as const satisfies Record<PlatformSecretRotationDomain, DomainRotationHandler>;

const handlerFor = (domain: PlatformSecretRotationDomain): DomainRotationHandler =>
  DOMAIN_HANDLERS[domain];

/**
 * Persistence-only foundation for bounded, resumable secret re-wrap.
 *
 * This repository deliberately does not decrypt, persist job cursors, emit
 * audit records, or update runtime/LKG state. In particular, an OIDC secret
 * CAS does not authorize an LKG reload: the future orchestrator must pass the
 * external OIDC last-known-good health gate before changing runtime state.
 */
export class PlatformSecretRotationRepository {
  private readonly db: LobeChatDatabase | Transaction;
  private readonly transactionScoped: boolean;

  constructor(db: LobeChatDatabase, transactionScoped?: false);
  constructor(db: Transaction, transactionScoped: true);
  constructor(db: LobeChatDatabase | Transaction, transactionScoped = false) {
    this.db = db;
    this.transactionScoped = transactionScoped;
  }

  /** Use inside an existing job transaction so data CAS and checkpoint commit atomically. */
  static forTransaction = (tx: Transaction) => new PlatformSecretRotationRepository(tx, true);

  getById = async (
    domain: PlatformSecretRotationDomain,
    id: string,
  ): Promise<PlatformSecretRotationCandidate | undefined> =>
    handlerFor(domain).getById(this.db, id);

  private listDomain = async (params: {
    afterId?: string;
    domain: PlatformSecretRotationDomain;
    limit: number;
    targetKeyId: string;
  }): Promise<PlatformSecretRotationCandidate[]> => {
    const { domain, ...rest } = params;
    return handlerFor(domain).listDomain(this.db, rest);
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
  }): Promise<PlatformSecretRotationCasResult> =>
    handlerFor(params.candidate.domain).rotateExact(
      { db: this.db, transactionScoped: this.transactionScoped },
      params,
    );
}
