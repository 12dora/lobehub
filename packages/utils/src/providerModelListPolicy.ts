import type { AiProviderModelListItem } from 'model-bank';
import {
  isAiModelVisible,
  normalizeAiModelType,
  resolveModelSearchDefaultSettings,
} from 'model-bank';

import { mergeArrayById } from './merge';

/**
 * Inject/remove search-related settings based on abilities.search (read-time only).
 * Shared by server AiInfraRepos and admin adapter so both stay on one contract.
 */
export const injectSearchSettings = <T extends Record<string, any>>(
  providerId: string,
  item: T,
): T => {
  const abilities = item?.abilities || {};

  if (abilities.search === false) {
    if (item?.settings?.searchImpl || item?.settings?.searchProvider) {
      const next = { ...item } as any;
      if (next.settings) {
        // eslint-disable-next-line unused-imports/no-unused-vars
        const { searchImpl, searchProvider, ...restSettings } = next.settings;
        next.settings = Object.keys(restSettings).length > 0 ? restSettings : undefined;
      }
      return next;
    }
    return item;
  }

  if (abilities.search === true) {
    if (item?.settings?.searchImpl || item?.settings?.searchProvider) return item;

    const searchSettings = resolveModelSearchDefaultSettings(providerId, item.id);

    return {
      ...item,
      settings: {
        ...item.settings,
        ...searchSettings,
      },
    };
  }

  return item;
};

export interface ProviderModelListPolicyOptions {
  /**
   * Branding provider id whose residual non-builtin rows are pruned.
   * Pass the same constant the server uses (`BRANDING_PROVIDER`).
   */
  brandingProviderId?: string;
  enabled?: boolean;
  limit?: number;
  offset?: number;
  type?: string;
}

/**
 * Pure merge + post-process policy for a provider's model list.
 * Single source of truth for server repository and admin client adapter.
 */
export const buildProviderModelList = (
  providerId: string,
  defaultModels: AiProviderModelListItem[],
  dbModels: AiProviderModelListItem[],
  options?: ProviderModelListPolicyOptions,
): AiProviderModelListItem[] => {
  let mergedModel = mergeArrayById(defaultModels, dbModels) as AiProviderModelListItem[];

  // Type always prefers builtin config; legacy `stt` → `asr` at read time.
  const builtinTypeMap = new Map(defaultModels.map((m) => [m.id, m.type]));
  for (const m of mergedModel) {
    const builtinType = builtinTypeMap.get(m.id);
    if (builtinType) m.type = builtinType;
    m.type = normalizeAiModelType(m.type);
  }

  if (options?.brandingProviderId && providerId === options.brandingProviderId) {
    const builtinIds = new Set(defaultModels.map((m) => m.id));
    mergedModel = mergedModel.filter((m) => builtinIds.has(m.id));
  }

  mergedModel = mergedModel.filter(isAiModelVisible);

  let list = mergedModel.map((m) =>
    injectSearchSettings(providerId, m),
  ) as AiProviderModelListItem[];

  if (typeof options?.enabled === 'boolean') {
    list = list.filter((m) => m.enabled === options.enabled);
  }

  if (options?.type) {
    list = list.filter((m) => m.type === options.type);
  }

  if (typeof options?.offset === 'number' || typeof options?.limit === 'number') {
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;
    if (typeof limit === 'number') return list.slice(offset, offset + Math.max(0, limit));
    return list.slice(offset);
  }

  return list;
};
