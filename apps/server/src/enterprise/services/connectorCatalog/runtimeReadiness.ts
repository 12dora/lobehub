import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { registerManagedResourceReadiness } from '../managedResourceReadiness';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import { getConnectorOAuthRuntime } from './oauthRuntime';

let registered = false;

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
  getConnectorOAuthRuntime(db, env);
  const repository = params.repository ?? new PlatformConnectorCatalogRepository(db);
  const page = await repository.listConnectors({
    enabled: true,
    limit: 1,
    status: 'published',
  });
  return page.items.length === 1;
};

export const ensureConnectorCatalogReadinessRegistered = (): void => {
  if (registered) return;
  registered = true;
  registerManagedResourceReadiness('connectors', () => resolveConnectorCatalogRuntimeReadiness());
};

export const resetConnectorCatalogReadinessRegistrationForTest = (): void => {
  registered = false;
};
