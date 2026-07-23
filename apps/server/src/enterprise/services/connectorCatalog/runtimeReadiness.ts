import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { connectorSharedCredentialSchema } from '../../contracts/platformConnectors';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { registerManagedResourceReadiness } from '../managedResourceReadiness';
import { ConnectorCatalogReadService, resolveConnectorSecretVersion } from './catalogSnapshot';
import type { ConnectorOAuthRuntimeDependencies, ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import { getConnectorOAuthRuntime } from './oauthRuntime';

let registered = false;
const READINESS_PAGE_SIZE = 100;
const MAX_READINESS_PAGES = 100;
const MAX_READINESS_ITEMS = 10_000;

interface ReadinessCursor {
  connectorKey: string;
  id: string;
}

const cursorKey = (cursor: ReadinessCursor): string =>
  JSON.stringify([cursor.connectorKey, cursor.id]);

const cursorAdvances = (current: ReadinessCursor, next: ReadinessCursor): boolean =>
  next.connectorKey > current.connectorKey ||
  (next.connectorKey === current.connectorKey && next.id > current.id);

export const resolveConnectorCatalogRuntimeReadiness = async (
  params: {
    db?: LobeChatDatabase;
    env?: ConnectorOAuthRuntimeEnv;
    readService?: Pick<ConnectorCatalogReadService, 'getSnapshot'>;
    repository?: Pick<PlatformConnectorCatalogRepository, 'listConnectors'>;
    runtime?: ConnectorOAuthRuntimeDependencies;
  } = {},
): Promise<boolean> => {
  const env = params.env ?? process.env;
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) return false;
  const db = params.db ?? ((await getServerDB()) as LobeChatDatabase);
  const runtime = params.runtime ?? getConnectorOAuthRuntime(db, env);
  if (!runtime.secrets.assertReady) return false;
  await runtime.secrets.assertReady();
  const repository = params.repository ?? new PlatformConnectorCatalogRepository(db);
  const read = params.readService ?? new ConnectorCatalogReadService(db, runtime.secrets);
  let cursor: Awaited<ReturnType<typeof repository.listConnectors>>['nextCursor'] | undefined;
  const seenCursors = new Set<string>();
  let published = 0;
  for (let pageIndex = 0; pageIndex < MAX_READINESS_PAGES; pageIndex += 1) {
    const page = await repository.listConnectors({
      cursor: cursor ?? undefined,
      enabled: true,
      limit: READINESS_PAGE_SIZE,
      status: 'published',
    });
    if (published + page.items.length > MAX_READINESS_ITEMS) return false;
    for (const listed of page.items) {
      const snapshot = await read.getSnapshot(listed.id);
      if (
        snapshot.provenance.revision !== listed.publishedRevision ||
        snapshot.payload.connector.credentialMode !== listed.credentialMode
      ) {
        return false;
      }
      const connector = snapshot.payload.connector;
      if (connector.credentialMode === 'shared_service_account') {
        const secret = await resolveConnectorSecretVersion(
          runtime.secrets,
          connector.id,
          'sharedSecret',
          connector.sharedSecretFingerprint,
        );
        connectorSharedCredentialSchema.parse(secret.value);
      } else if (
        connector.credentialMode === 'per_user_oauth' &&
        connector.oauthClientSecretConfigured
      ) {
        await resolveConnectorSecretVersion(
          runtime.secrets,
          connector.id,
          'oauthClientSecret',
          connector.oauthClientSecretFingerprint,
        );
      }
      published += 1;
    }
    if (!page.nextCursor) return published > 0;
    const nextCursorKey = cursorKey(page.nextCursor);
    if (seenCursors.has(nextCursorKey) || (cursor && !cursorAdvances(cursor, page.nextCursor))) {
      return false;
    }
    seenCursors.add(nextCursorKey);
    cursor = page.nextCursor;
  }
  return false;
};

export const ensureConnectorCatalogReadinessRegistered = (): void => {
  if (registered) return;
  registered = true;
  registerManagedResourceReadiness('connectors', () => resolveConnectorCatalogRuntimeReadiness());
};
