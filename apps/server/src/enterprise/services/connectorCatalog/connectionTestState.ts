/**
 * Revision/token-bound connection-test bookkeeping for connector publish gates.
 *
 * Durable source of truth: `platform_connectors.connection_test_*` columns
 * (declared in the Drizzle schema; formal migration is owned by the DB batch).
 * Never run DDL on request paths. Absent / unreadable / expired / mismatched
 * results fail closed at publish — no process-local authorization fallback.
 */
import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import { type PlatformConnectorItem, platformConnectors } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { connectorConnectionTestStateSchema } from '../../contracts/platformConnectors';

export type ConnectorConnectionTestState = z.infer<typeof connectorConnectionTestStateSchema>;

type StoredConnectionTest = Omit<ConnectorConnectionTestState, 'stale'>;

/** Successful probes older than this are treated as expired (fail-closed at publish). */
export const CONNECTOR_CONNECTION_TEST_TTL_MS = 24 * 60 * 60 * 1000;

const isMissingColumnError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /connection_test_|column .* does not exist|undefined column/i.test(message);
};

const isExpired = (testedAt: Date, now: Date = new Date()): boolean =>
  now.getTime() - testedAt.getTime() > CONNECTOR_CONNECTION_TEST_TTL_MS;

const projectStored = (
  stored: StoredConnectionTest,
  current: { draftToken: string; revision: number },
  now: Date = new Date(),
): ConnectorConnectionTestState | null => {
  if (isExpired(stored.testedAt, now)) return null;
  const stale =
    stored.testedDraftToken !== current.draftToken || stored.testedRevision !== current.revision;
  return { ...stored, stale };
};

/** Project durable columns (or null when absent / incomplete / expired). */
export const projectConnectorConnectionTestFromRow = (
  connector: Pick<
    PlatformConnectorItem,
    | 'connectionTestErrorCategory'
    | 'connectionTestLatencyMs'
    | 'connectionTestMessageCode'
    | 'connectionTestStatus'
    | 'connectionTestedAt'
    | 'connectionTestedDraftToken'
    | 'connectionTestedRevision'
  >,
  current: { draftToken: string; revision: number },
  now: Date = new Date(),
): ConnectorConnectionTestState | null => {
  if (
    !connector.connectionTestStatus ||
    !connector.connectionTestedAt ||
    !connector.connectionTestedDraftToken ||
    connector.connectionTestedRevision === null ||
    connector.connectionTestedRevision === undefined ||
    !connector.connectionTestMessageCode
  ) {
    return null;
  }
  return projectStored(
    {
      errorCategory: connector.connectionTestErrorCategory ?? null,
      latencyMs: connector.connectionTestLatencyMs ?? null,
      messageCode:
        connector.connectionTestMessageCode as ConnectorConnectionTestState['messageCode'],
      status: connector.connectionTestStatus,
      testedAt: connector.connectionTestedAt,
      testedDraftToken: connector.connectionTestedDraftToken,
      testedRevision: connector.connectionTestedRevision,
    },
    current,
    now,
  );
};

/**
 * Persist a probe result to durable row columns (connectorId + revision + draftToken + testedAt).
 * Call after a live connection test so any instance can publish. No request-time DDL.
 */
export const recordConnectorConnectionTest = async (
  db: LobeChatDatabase | Transaction,
  connectorId: string,
  state: StoredConnectionTest,
): Promise<void> => {
  await db
    .update(platformConnectors)
    .set({
      connectionTestErrorCategory: state.errorCategory,
      connectionTestLatencyMs: state.latencyMs,
      connectionTestMessageCode: state.messageCode,
      connectionTestStatus: state.status,
      connectionTestedAt: state.testedAt,
      connectionTestedDraftToken: state.testedDraftToken,
      connectionTestedRevision: state.testedRevision,
    })
    .where(eq(platformConnectors.id, connectorId));
};

/**
 * Resolve the probe for the current draft identity from durable columns only.
 * Missing / expired / unreadable (e.g. pre-migration) → null (fail closed).
 * Token/revision mismatch → same status with stale:true when a complete probe exists.
 */
export const resolveConnectorConnectionTest = async (
  db: LobeChatDatabase | Transaction,
  connectorId: string,
  current: { draftToken: string; revision: number },
): Promise<ConnectorConnectionTestState | null> => {
  try {
    const [row] = await db
      .select({
        connectionTestErrorCategory: platformConnectors.connectionTestErrorCategory,
        connectionTestLatencyMs: platformConnectors.connectionTestLatencyMs,
        connectionTestMessageCode: platformConnectors.connectionTestMessageCode,
        connectionTestStatus: platformConnectors.connectionTestStatus,
        connectionTestedAt: platformConnectors.connectionTestedAt,
        connectionTestedDraftToken: platformConnectors.connectionTestedDraftToken,
        connectionTestedRevision: platformConnectors.connectionTestedRevision,
      })
      .from(platformConnectors)
      .where(eq(platformConnectors.id, connectorId))
      .limit(1);
    if (!row) return null;
    return projectConnectorConnectionTestFromRow(row, current);
  } catch (error) {
    // Pre-migration / columns unavailable: never authorize from process memory.
    if (isMissingColumnError(error)) return null;
    throw error;
  }
};

/** Clear durable connection-test columns (after successful draft delete when row may remain). */
export const clearConnectorConnectionTest = async (
  db: LobeChatDatabase | Transaction | null,
  connectorId: string,
): Promise<void> => {
  if (!db) return;
  try {
    await db
      .update(platformConnectors)
      .set({
        connectionTestErrorCategory: null,
        connectionTestLatencyMs: null,
        connectionTestMessageCode: null,
        connectionTestStatus: null,
        connectionTestedAt: null,
        connectionTestedDraftToken: null,
        connectionTestedRevision: null,
      })
      .where(eq(platformConnectors.id, connectorId));
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;
  }
};

/**
 * @deprecated Process-local L1 was removed (fail-closed durable-only). Kept as a no-op
 * so existing tests that wipe "other process" memory remain valid.
 */
export const resetConnectorConnectionTestMemoryForTest = (): void => {
  // no-op: durable columns are the sole source of truth
};

/** Test-only: full reset hook (durable-only design; no process-local state). */
export const resetConnectorConnectionTestStateForTest = (): void => {
  // no-op
};
