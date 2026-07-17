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
import type { AdminAgentDetailOutput, AdminAgentListInput, AdminAgentsClient } from './types';

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

const collectPages = async <T>(fetchPage: (cursor?: string) => Promise<CursorPage<T>>) => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
};

export const fetchAllAdminAgents = async (
  input: Omit<AdminAgentListInput, 'cursor' | 'limit'>,
  client: AdminAgentsClient,
) => collectPages((cursor) => client.list({ ...input, cursor, limit: 100 }));

export const fetchAdminAgentDetail = async (
  id: string,
  client: AdminAgentsClient,
): Promise<AdminAgentDetailOutput> => {
  const [detail, assignments, rollouts, versions] = await Promise.all([
    client.get({ id }),
    collectPages((cursor) => client.listAssignments({ agentId: id, cursor, limit: 100 })),
    // Rollouts have no core router yet (PR-052). Skip the read entirely when the adapter
    // reports the capability off, rather than calling a mock/absent endpoint.
    client.capabilities.rollouts
      ? collectPages((cursor) => client.listRollouts({ agentId: id, cursor, limit: 100 }))
      : Promise.resolve([] as AdminAgentDetailOutput['rollouts']),
    collectPages((cursor) => client.listVersions({ agentId: id, cursor, limit: 100 })),
  ]);

  return { ...detail, assignments, rollouts, versions };
};

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
  useClientDataSWR(buildAdminAgentGetKey(id, enabled), () => fetchAdminAgentDetail(id!, client), {
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
