import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';

import type { AdminAiProviderGetOutput } from '@/enterprise/client/features/admin/ai/types';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { lambdaClient } from '@/libs/trpc/client';
import type { CreateAiProviderParams } from '@/types/aiProvider';
import { AiProviderSourceEnum } from '@/types/aiProvider';

import { withAdminAiInfraErrorToast } from './errors';

export const DEFAULT_REASON = 'admin provider settings auto-publish';

export type AdminPublishOutcome = {
  providerId: string;
  published: boolean;
  publishError?: string | null;
};

/**
 * Explicit service-owned store for the last applyImmediate/publishNow outcome.
 * Avoids a bare module-level `let` global while keeping a stable singleton API
 * for DraftPublishBanner (no React store dependency in the adapter layer).
 */
class AdminPublishOutcomeStore {
  #outcome: AdminPublishOutcome | null = null;

  clear = () => {
    this.#outcome = null;
  };

  get = () => this.#outcome;

  record = (providerKey: string, result: { published?: boolean; publishError?: string | null }) => {
    this.#outcome = {
      providerId: providerKey,
      published: result.published !== false,
      publishError: result.publishError ?? null,
    };
  };
}

/** Singleton store used by provider/model adapter writes and the draft banner. */
export const adminPublishOutcomeStore = new AdminPublishOutcomeStore();

export const getLastAdminPublishOutcome = () => adminPublishOutcomeStore.get();
export const clearLastAdminPublishOutcome = () => {
  adminPublishOutcomeStore.clear();
};

export const recordPublishOutcome = (
  providerKey: string,
  result: { published?: boolean; publishError?: string | null },
) => {
  adminPublishOutcomeStore.record(providerKey, result);
};

/** Platform UUIDs use standard hex-with-hyphens shape; everything else is treated as providerKey. */
const PLATFORM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve platform detail by providerKey (preferred) or platform UUID.
 * Uses server O(1) lookup — no full-list scan.
 */
export const getDetail = async (providerKeyOrId: string): Promise<AdminAiProviderGetOutput> => {
  if (PLATFORM_UUID_RE.test(providerKeyOrId)) {
    return lambdaClient.admin.aiProviders.get.query({ id: providerKeyOrId });
  }
  return lambdaClient.admin.aiProviders.get.query({ providerKey: providerKeyOrId });
};

/**
 * Backward-compatible helper: resolve the platform draft row (id + providerKey) without
 * paginating the entire provider list.
 */
export const resolveProviderRecord = async (providerKeyOrId: string) => {
  const detail = await getDetail(providerKeyOrId);
  return detail.draft;
};

/** Known built-in provider card (client catalog) used to seed the platform DB lazily. */
export const findBuiltinProviderCard = (id: string) =>
  DEFAULT_MODEL_PROVIDER_LIST.find((card) => card.id === id);

export const withReauth = <T>(fn: () => Promise<T>): Promise<T> =>
  withAdminAiInfraErrorToast(() => withAdminReauthRetry(fn));

/**
 * Resolve the platform detail for a provider, creating the platform DB row on the
 * first write for a known built-in that hasn't been configured yet.
 *
 * Circular import note: create path is injected to avoid model↔provider cycle.
 */
export const createGetOrCreateDetail = (
  createAiProvider: (params: CreateAiProviderParams) => Promise<unknown>,
) => {
  return async (providerKeyOrId: string): Promise<AdminAiProviderGetOutput> => {
    try {
      return await getDetail(providerKeyOrId);
    } catch (cause) {
      const card = findBuiltinProviderCard(providerKeyOrId);
      if (!card) throw cause;
      await createAiProvider({
        description: card.description,
        id: card.id,
        name: card.name,
        settings: card.settings as CreateAiProviderParams['settings'],
        source: AiProviderSourceEnum.Builtin,
      });
      return getDetail(providerKeyOrId);
    }
  };
};
