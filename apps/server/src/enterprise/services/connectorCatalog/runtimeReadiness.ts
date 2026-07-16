import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { registerManagedResourceReadiness } from '../managedResourceReadiness';
import { ConnectorCatalogReadService, resolveConnectorSecretVersion } from './catalogSnapshot';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import { getConnectorOAuthRuntime } from './oauthRuntime';

let registered = false;
const READINESS_PAGE_SIZE = 100;
const MAX_READINESS_PAGES = 100;

export const resolveConnectorCatalogRuntimeReadiness = async (
  params: {
    db?: LobeChatDatabase;
    env?: ConnectorOAuthRuntimeEnv;
    repository?: Pick<PlatformConnectorCatalogRepository, 'listConnectors'>;
  } = {},
): Promise<boolean> => {
  const env = params.env ?? process.env;
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) return false;
  const db = params.db ?? ((await getServerDB()) as LobeChatDatabase);
  const runtime = getConnectorOAuthRuntime(db, env);
  if (!runtime.secrets.assertReady) return false;
  await runtime.secrets.assertReady();
  const repository = params.repository ?? new PlatformConnectorCatalogRepository(db);
  const read = new ConnectorCatalogReadService(db, runtime.secrets);
  let cursor: Awaited<ReturnType<typeof repository.listConnectors>>['nextCursor'] | undefined;
  let published = 0;
  for (let pageIndex = 0; pageIndex < MAX_READINESS_PAGES; pageIndex += 1) {
    const page = await repository.listConnectors({
      cursor: cursor ?? undefined,
      enabled: true,
      limit: READINESS_PAGE_SIZE,
      status: 'published',
    });
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
        await read.getTrustedPublished(connector.id);
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
    if (cursor && page.nextCursor.id === cursor.id) return false;
    cursor = page.nextCursor;
  }
  return false;
};

export const ensureConnectorCatalogReadinessRegistered = (): void => {
  if (registered) return;
  registered = true;
  registerManagedResourceReadiness('connectors', () => resolveConnectorCatalogRuntimeReadiness());
};

export const resetConnectorCatalogReadinessRegistrationForTest = (): void => {
  registered = false;
};
