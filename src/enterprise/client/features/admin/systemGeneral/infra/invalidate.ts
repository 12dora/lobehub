'use client';

import { mutate } from 'swr';

import { ADMIN_SYSTEM_INFRA_SETTINGS_KEY } from '../swrKeys';

/**
 * Refresh the 基础设施 snapshot after a write.
 *
 * Matched by predicate rather than by key literal because `useClientDataSWR` appends the active
 * workspace id to the key — an exact-key mutate would silently no-op.
 */
export const invalidateAdminInfraSettings = (): Promise<unknown> =>
  mutate((key) => Array.isArray(key) && key[0] === ADMIN_SYSTEM_INFRA_SETTINGS_KEY);
