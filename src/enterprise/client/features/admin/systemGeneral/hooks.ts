'use client';

import { useCallback, useRef, useState } from 'react';

import type {
  AdminInfraSettingsService,
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';
import { useClientDataSWR } from '@/libs/swr';
import type { AdminSystemInfraDependency } from '@/server/enterprise/contracts/adminSystem';

import { buildAdminInfraSettingsKey } from './swrKeys';

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
