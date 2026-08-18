'use client';

import { useCallback, useRef, useState } from 'react';

import type {
  AdminBrowserProfileService,
  AdminInfraSettingsService,
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';
import { useClientDataSWR } from '@/libs/swr';
import type { AdminSystemInfraDependency } from '@/server/enterprise/contracts/adminSystem';

import {
  buildAdminBrowserProfileKey,
  buildAdminBrowserProfileOptionsKey,
  buildAdminInfraSettingsKey,
} from './swrKeys';

export const useAdminBrowserProfile = (enabled: boolean, service: AdminBrowserProfileService) =>
  useClientDataSWR(buildAdminBrowserProfileKey(enabled), () => service.getBrowserProfile(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

/**
 * The pools a fingerprint may be composed from. They are compiled into the build, so unlike the
 * profile itself they cannot go stale while the page is open.
 */
export const useAdminBrowserProfileOptions = (
  enabled: boolean,
  service: AdminBrowserProfileService,
) =>
  useClientDataSWR(
    buildAdminBrowserProfileOptionsKey(enabled),
    () => service.getBrowserProfileOptions(),
    { keepPreviousData: true, revalidateIfStale: false, revalidateOnFocus: false },
  );

export const useAdminInfraSettings = (enabled: boolean, service: AdminInfraSettingsService) =>
  useClientDataSWR(buildAdminInfraSettingsKey(enabled), () => service.getInfraSettings(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export interface InfraProbeState {
  busy: Partial<Record<AdminSystemInfraDependency, boolean>>;
  results: Partial<Record<AdminSystemInfraDependency, AdminSystemTestDependencyResult>>;
  run: (dependency: AdminSystemInfraDependency) => Promise<void>;
}

export const useInfraDependencyProbe = (service: AdminInfraSettingsService): InfraProbeState => {
  const inFlight = useRef(new Set<AdminSystemInfraDependency>());
  const [busy, setBusy] = useState<Partial<Record<AdminSystemInfraDependency, boolean>>>({});
  const [results, setResults] = useState<
    Partial<Record<AdminSystemInfraDependency, AdminSystemTestDependencyResult>>
  >({});

  const run = useCallback(
    async (dependency: AdminSystemInfraDependency) => {
      if (inFlight.current.has(dependency)) return;
      inFlight.current.add(dependency);
      setBusy((current) => ({ ...current, [dependency]: true }));
      try {
        const result = await service.testDependency({ dependency });
        setResults((current) => ({ ...current, [dependency]: result }));
      } catch {
        setResults((current) => ({
          ...current,
          [dependency]: {
            checkedAt: new Date(),
            latencyMs: 0,
            message: 'unreachable',
            ok: false,
          },
        }));
      } finally {
        inFlight.current.delete(dependency);
        setBusy((current) => ({ ...current, [dependency]: false }));
      }
    },
    [service],
  );

  return { busy, results, run };
};

export type { AdminSystemInfraSettings };
