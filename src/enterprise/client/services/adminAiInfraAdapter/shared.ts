import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { useSyncExternalStore } from 'react';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminAiProviderGetOutput } from '@/enterprise/client/features/admin/ai/types';
import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { lambdaClient } from '@/libs/trpc/client';
import type { CreateAiProviderParams } from '@/types/aiProvider';
import { AiProviderSourceEnum } from '@/types/aiProvider';

import { withAdminAiInfraErrorToast } from './errors';

/**
 * True only when the platform row is genuinely absent — not for permission, network,
 * or feature-disable failures (those must surface as errors, not silent create/fallback).
 */
export const isPlatformNotFoundError = (cause: unknown): boolean =>
  mapEnterpriseError(cause)?.code === PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND;

export const DEFAULT_REASON = 'admin provider settings auto-publish';

export type AdminPublishOutcome = {
  providerId: string;
  published: boolean;
  publishError?: string | null;
};

/**
 * Explicit service-owned store for the last applyImmediate/publishNow outcome.
 * Observable via subscribe/getSnapshot so React can use useSyncExternalStore
 * without coupling the adapter layer to a UI store framework.
 */
class AdminPublishOutcomeStore {
  #outcome: AdminPublishOutcome | null = null;
  #listeners = new Set<() => void>();

  clear = () => {
    if (this.#outcome === null) return;
    this.#outcome = null;
    this.#emit();
  };

  get = () => this.#outcome;

  getSnapshot = () => this.#outcome;

  record = (providerKey: string, result: { published?: boolean; publishError?: string | null }) => {
    this.#outcome = {
      providerId: providerKey,
      published: result.published !== false,
      publishError: result.publishError ?? null,
    };
    this.#emit();
  };

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #emit = () => {
    for (const listener of this.#listeners) listener();
  };
}

/** Singleton store used by provider/model adapter writes and the draft banner. */
export const adminPublishOutcomeStore = new AdminPublishOutcomeStore();

export const clearLastAdminPublishOutcome = () => {
  adminPublishOutcomeStore.clear();
};

export const recordPublishOutcome = (
  providerKey: string,
  result: { published?: boolean; publishError?: string | null },
) => {
  adminPublishOutcomeStore.record(providerKey, result);
};

/**
 * React-friendly subscription to the last admin publish outcome.
 * Lives next to the store so DraftPublishBanner re-renders when record() fires.
 */
export const useAdminPublishOutcome = (): AdminPublishOutcome | null =>
  useSyncExternalStore(
    adminPublishOutcomeStore.subscribe,
    adminPublishOutcomeStore.getSnapshot,
    adminPublishOutcomeStore.getSnapshot,
  );

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
      // Only PLATFORM_NOT_FOUND means "no row yet" — rethrow forbidden/network/server errors.
      if (!isPlatformNotFoundError(cause)) throw cause;
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
