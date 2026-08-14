import { lambdaClient } from '@/libs/trpc/client';

import type {
  AdminAiProviderGetInput,
  AdminAiProviderGetOutput,
  AdminAiProviderListInput,
  AdminAiProviderListOutput,
  AdminAiProviderRevisionHistoryInput,
  AdminAiProviderRevisionHistoryOutput,
} from '../features/admin/ai/types';

/**
 * Read-only client boundary for the platform AI catalog.
 *
 * Provider/model *writes* go through `adminAiInfraAdapter` (applyImmediate) — this service
 * only serves catalog reads that other admin domains need. Its remaining consumer is the
 * admin agents dependency picker, which must pin an EXACT `(providerRevision, checksum)`
 * pair and therefore still joins provider detail with the published revision history.
 */
class AdminAiCatalogService {
  getProvider = async (input: AdminAiProviderGetInput): Promise<AdminAiProviderGetOutput> =>
    lambdaClient.admin.aiProviders.get.query(input);

  listProviders = async (input: AdminAiProviderListInput): Promise<AdminAiProviderListOutput> =>
    lambdaClient.admin.aiProviders.list.query(input);

  /**
   * REQUIRED SERVER CONTRACT — do not delete with the draft/publish UI.
   *
   * `admin.aiProviders.listRevisions` is a read-only history query, not part of the removed
   * draft/publish surface. It is the ONLY client-visible source of a published provider's
   * checksum, which `DependencyEditor` needs to pin an exact `(providerRevision, checksum)`
   * agent model ref. Without it the agents dependency picker fails closed and NO agent can be
   * saved. If it ever has to go, `publishedAiProviderSchema` must expose `publishedChecksum`
   * first (the way `admin.connectors.get` already does).
   */
  listProviderRevisions = async (
    input: AdminAiProviderRevisionHistoryInput,
  ): Promise<AdminAiProviderRevisionHistoryOutput> =>
    lambdaClient.admin.aiProviders.listRevisions.query(input);
}

export const adminAiCatalogService = new AdminAiCatalogService();
