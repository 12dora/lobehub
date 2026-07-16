'use client';

import { mutate } from 'swr';

import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';
import { useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_AI_MODEL_LIST_KEY,
  ADMIN_AI_PROVIDER_GET_KEY,
  ADMIN_AI_PROVIDER_LIST_KEY,
  ADMIN_AI_PROVIDER_REVISIONS_KEY,
  buildAdminAiModelDependentsKey,
  buildAdminAiModelListKey,
  buildAdminAiProviderGetKey,
  buildAdminAiProviderListKey,
  buildAdminAiProviderRevisionsKey,
} from '../swrKeys';
import type { AdminAiModelListInput, AdminAiProviderListInput } from '../types';

export const useFetchAdminAiProviders = (input: AdminAiProviderListInput, enabled = true) =>
  useClientDataSWR(
    enabled ? buildAdminAiProviderListKey(input) : null,
    () => adminAiCatalogService.listProviders(input),
    { revalidateOnFocus: false },
  );

export const useFetchAdminAiProvider = (id: string | undefined, enabled = true) =>
  useClientDataSWR(
    enabled && id ? buildAdminAiProviderGetKey(id) : null,
    () => adminAiCatalogService.getProvider({ id: id! }),
    { revalidateOnFocus: false },
  );

export const useFetchAdminAiModels = (input: AdminAiModelListInput, enabled = true) =>
  useClientDataSWR(
    enabled ? buildAdminAiModelListKey(input) : null,
    () => adminAiCatalogService.listModels(input),
    { revalidateOnFocus: false },
  );

export const useFetchAdminAiProviderRevisions = (
  id: string | undefined,
  enabled = true,
  beforeRevision?: number,
  limit = 50,
) =>
  useClientDataSWR(
    enabled && id ? buildAdminAiProviderRevisionsKey(id, beforeRevision, limit) : null,
    () => adminAiCatalogService.listProviderRevisions({ beforeRevision, id: id!, limit }),
    { revalidateOnFocus: false },
  );

export const useFetchAdminAiModelDependents = (
  providerId: string | undefined,
  id: string | undefined,
  enabled = true,
) =>
  useClientDataSWR(
    enabled && providerId && id ? buildAdminAiModelDependentsKey(providerId, id) : null,
    () => adminAiCatalogService.getModelDependents({ id: id!, providerId: providerId! }),
    { revalidateOnFocus: false },
  );

export const refreshAdminAiProviderLists = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_AI_PROVIDER_LIST_KEY);
};

export const refreshAdminAiProvider = async (id: string) => {
  await Promise.all([
    mutate(buildAdminAiProviderGetKey(id)),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_AI_PROVIDER_LIST_KEY),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_AI_PROVIDER_REVISIONS_KEY),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_AI_MODEL_LIST_KEY),
  ]);
};

export const clearAdminAiProviderCache = async () => {
  await mutate(
    (key) =>
      Array.isArray(key) &&
      (key[0] === ADMIN_AI_PROVIDER_GET_KEY || key[0] === ADMIN_AI_PROVIDER_LIST_KEY),
    undefined,
    { revalidate: false },
  );
};
