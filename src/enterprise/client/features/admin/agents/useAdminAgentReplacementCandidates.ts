'use client';

import { useEffect, useState } from 'react';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';
import { useClientDataSWR } from '@/libs/swr';

import type { AdminAgentListItem, AdminAgentsClient } from './types';
import { fetchPublishedAdminAgentReplacements } from './useAdminAgents';

const REPLACEMENT_KEY = 'enterprise.admin.agents.archive.replacements';
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Debounced value for server-side search keys. Keeps request identity stable while typing.
 */
export const useDebouncedValue = <T>(value: T, delayMs = DEFAULT_DEBOUNCE_MS): T => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [delayMs, value]);
  return debounced;
};

/**
 * Published replacement candidates for archive-default. SWR owns loading/error/retry; the key
 * includes excludeAgentId + debounced query so a concurrent stale response cannot paint the wrong
 * Agent's candidates. Disabled when `enabled` is false (non-default archive skips the picker).
 */
export const useAdminAgentReplacementCandidates = (
  excludeAgentId: string,
  query: string,
  enabled: boolean,
  client: AdminAgentsClient = adminAgentsService,
) => {
  const debouncedQuery = useDebouncedValue(query);
  const trimmed = debouncedQuery.trim();
  return useClientDataSWR<AdminAgentListItem[]>(
    enabled ? [REPLACEMENT_KEY, excludeAgentId, trimmed] : null,
    () =>
      fetchPublishedAdminAgentReplacements(excludeAgentId, client, {
        limit: 50,
        query: trimmed || undefined,
      }),
    { revalidateOnFocus: false },
  );
};
