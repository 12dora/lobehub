'use client';

import { mutate } from 'swr';

import { adminAiCatalogService } from '@/enterprise/client/services/adminAiCatalog';
import { useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_AI_PROVIDER_GET_KEY,
  ADMIN_AI_PROVIDER_LIST_KEY,
  buildAdminAiModelDependentsKey,
  buildAdminAiProviderGetKey,
  buildAdminAiProviderListKey,
} from '../swrKeys';
import type { AdminAiProviderListInput } from '../types';

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
