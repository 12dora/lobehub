'use client';

import { mutate } from 'swr';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';
import { useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_AGENT_GET_KEY,
  ADMIN_AGENT_LIST_KEY,
  buildAdminAgentGetKey,
  buildAdminAgentListKey,
} from './swrKeys';
import type { AdminAgentListInput, AdminAgentsClient } from './types';

export const useFetchAdminAgents = (
  input: AdminAgentListInput,
  enabled: boolean,
  client: AdminAgentsClient = adminAgentsService,
) =>
  useClientDataSWR(buildAdminAgentListKey(input, enabled), () => client.list(input), {
    revalidateOnFocus: false,
  });

export const useFetchAdminAgent = (
  id: string | undefined,
  enabled: boolean,
  client: AdminAgentsClient = adminAgentsService,
) =>
  useClientDataSWR(buildAdminAgentGetKey(id, enabled), () => client.get({ id: id! }), {
    revalidateOnFocus: false,
  });

export const refreshAdminAgentLists = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_AGENT_LIST_KEY);
};

export const refreshAdminAgent = async (id: string) => {
  const [detail] = await Promise.all([
    mutate(buildAdminAgentGetKey(id, true)),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_AGENT_LIST_KEY),
  ]);
  return detail;
};

export const clearAdminAgentCache = async () => {
  await mutate(
    (key) =>
      Array.isArray(key) && (key[0] === ADMIN_AGENT_GET_KEY || key[0] === ADMIN_AGENT_LIST_KEY),
    undefined,
    { revalidate: false },
  );
};
