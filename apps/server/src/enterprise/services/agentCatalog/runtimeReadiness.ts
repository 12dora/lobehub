import debug from 'debug';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { registerManagedResourceReadiness } from '../managedResourceReadiness';
import { isModuleEnabled } from '../moduleSettings';

const log = debug('lobe-server:agent-catalog-readiness');

let registered = false;

const describeExecutionFailure = (error: unknown): string =>
  error instanceof Error ? error.name : 'UnknownError';

export const resolveAgentCatalogRuntimeReadiness = async (
  params: {
    db?: LobeChatDatabase;
    flags?: EnterpriseFeatureFlags;
    repository?: Pick<PlatformAgentCatalogRepository, 'listIdentities'>;
  } = {},
): Promise<boolean> => {
  try {
    const flags = params.flags ?? parseEnterpriseFeatureFlags(process.env);
    if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return false;
    // Hot view: registration always happens (G2); the probe no-ops when the module is off.
    if (!params.flags && !(await isModuleEnabled('managedAgents'))) return false;

    const db = params.db ?? (await getServerDB());
    const repository = params.repository ?? new PlatformAgentCatalogRepository(db);
    const published = await repository.listIdentities({ limit: 1, status: 'published' });
    return published.items.length > 0;
  } catch (error) {
    // Never rethrow: the readiness registry logs the raw rejection. Only the
    // error class is safe to emit (message/stack can carry query context).
    log('probe failed (%s)', describeExecutionFailure(error));
    return false;
  }
};

/** Registers a lazy DB-backed probe; registration itself performs no I/O. */
export const ensureAgentCatalogReadinessRegistered = (): void => {
  if (registered) return;
  registered = true;
  registerManagedResourceReadiness('agents', async () => {
    try {
      return await resolveAgentCatalogRuntimeReadiness();
    } catch (error) {
      log('probe failed (%s)', describeExecutionFailure(error));
      return false;
    }
  });
};

export const resetAgentCatalogReadinessRegistrationForTest = (): void => {
  registered = false;
};
