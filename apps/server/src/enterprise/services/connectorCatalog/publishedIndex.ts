import { checksumPayload } from '@/database/models/platform';
import {
  PlatformConnectorCatalogRepository,
  type PlatformConnectorRevisionPayload,
} from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { connectorOperationProofSchema } from '../../contracts/platformConnectors';
import { parseConnectorRevisionPayload } from './catalogSnapshot';
import type { FrozenConnectorOperationSnapshot } from './operationSnapshot';
import { fingerprintConnectorToolPolicy } from './toolPolicy';

interface CachedPublishedConnector {
  connectorId: string;
  connectorKey: string;
  payload: PlatformConnectorRevisionPayload;
  publishedAt: Date;
  publishedChecksum: string;
  publishedRevision: number;
  toolPolicyFingerprint: string;
}

export type ConnectorPublishedIndexResult =
  | { kind: 'published'; snapshot: FrozenConnectorOperationSnapshot }
  | { connectorId: string; connectorKey: string; kind: 'tombstone' }
  | { kind: 'unknown' };

const MAX_INDEX_ENTRIES = 512;
const indexByDatabase = new WeakMap<object, ConnectorPublishedIndex>();

const deepFreeze = <T>(value: T): T => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
};

/** Per-key pointer probe is O(1); payload validation is cached by exact pointer. */
export class ConnectorPublishedIndex {
  private readonly cache = new Map<string, CachedPublishedConnector>();

  constructor(
    private readonly repository: Pick<
      PlatformConnectorCatalogRepository,
      'getConnectorByKey' | 'getCurrentPublishedRuntime'
    >,
  ) {}

  resolveCurrent = async (params: {
    connectorKey: string;
    operationId: string;
  }): Promise<ConnectorPublishedIndexResult> => {
    const connector = await this.repository.getConnectorByKey(params.connectorKey);
    if (!connector) return { kind: 'unknown' };
    if (
      connector.status !== 'published' ||
      !connector.enabled ||
      !connector.publishedRevision ||
      !connector.publishedChecksum
    ) {
      return { connectorId: connector.id, connectorKey: connector.connectorKey, kind: 'tombstone' };
    }
    const cacheKey = [
      connector.id,
      connector.connectorKey,
      connector.publishedRevision,
      connector.publishedChecksum,
    ].join(':');
    let cached = this.cache.get(cacheKey);
    if (!cached) {
      const runtime = await this.repository.getCurrentPublishedRuntime(connector.id);
      if (
        !runtime ||
        runtime.provenance.revision !== connector.publishedRevision ||
        runtime.provenance.checksum !== connector.publishedChecksum ||
        checksumPayload(runtime.payload) !== runtime.provenance.checksum
      ) {
        return {
          connectorId: connector.id,
          connectorKey: connector.connectorKey,
          kind: 'tombstone',
        };
      }
      const payload = parseConnectorRevisionPayload(runtime.payload);
      if (
        payload.connector.id !== connector.id ||
        payload.connector.key !== connector.connectorKey ||
        !payload.connector.enabled
      ) {
        return {
          connectorId: connector.id,
          connectorKey: connector.connectorKey,
          kind: 'tombstone',
        };
      }
      cached = deepFreeze({
        connectorId: connector.id,
        connectorKey: connector.connectorKey,
        payload: structuredClone(payload),
        publishedAt: new Date(runtime.provenance.publishedAt),
        publishedChecksum: connector.publishedChecksum,
        publishedRevision: connector.publishedRevision,
        toolPolicyFingerprint: fingerprintConnectorToolPolicy(payload.tools),
      });
      this.cache.set(cacheKey, cached);
      while (this.cache.size > MAX_INDEX_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, cached);
    return {
      kind: 'published',
      snapshot: {
        payload: cached.payload,
        proof: connectorOperationProofSchema.parse({
          connectorId: cached.connectorId,
          connectorKey: cached.connectorKey,
          operationId: params.operationId,
          publishedChecksum: cached.publishedChecksum,
          publishedRevision: cached.publishedRevision,
          toolPolicyFingerprint: cached.toolPolicyFingerprint,
        }),
        publishedAt: cached.publishedAt,
      },
    };
  };

  invalidate = (connectorId?: string): void => {
    if (!connectorId) {
      this.cache.clear();
      return;
    }
    for (const [key, value] of this.cache) {
      if (value.connectorId === connectorId) this.cache.delete(key);
    }
  };
}

export const getConnectorPublishedIndex = (db: LobeChatDatabase): ConnectorPublishedIndex => {
  const key = db as object;
  const existing = indexByDatabase.get(key);
  if (existing) return existing;
  const created = new ConnectorPublishedIndex(new PlatformConnectorCatalogRepository(db));
  indexByDatabase.set(key, created);
  return created;
};

export const invalidateConnectorPublishedIndex = (
  db: LobeChatDatabase,
  connectorId?: string,
): void => getConnectorPublishedIndex(db).invalidate(connectorId);
