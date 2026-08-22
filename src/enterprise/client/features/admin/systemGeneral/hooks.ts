'use client';

import { useCallback, useRef, useState } from 'react';

import type {
  AdminBrowserProfileService,
  AdminDocumentRenderSettingsService,
  AdminInfraSettingsService,
  AdminSandboxSettingsService,
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';
import { useClientDataSWR } from '@/libs/swr';
import type { AdminSystemInfraDependency } from '@/server/enterprise/contracts/adminSystem';

import {
  buildAdminBrowserProfileKey,
  buildAdminBrowserProfileOptionsKey,
  buildAdminDocumentRenderSettingsKey,
  buildAdminDocumentRenderStatusKey,
  buildAdminInfraSettingsKey,
  buildAdminSandboxSettingsKey,
} from './swrKeys';

/** Queue depth and sidecar health move on their own; 15s is the same cadence 网络代理 polls at. */
const DOCUMENT_RENDER_STATUS_REFRESH_MS = 15_000;

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

export const useAdminSandboxSettings = (enabled: boolean, service: AdminSandboxSettingsService) =>
  useClientDataSWR(buildAdminSandboxSettingsKey(enabled), () => service.getSandboxSettings(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

export const useAdminDocumentRenderSettings = (
  enabled: boolean,
  service: AdminDocumentRenderSettingsService,
) =>
  useClientDataSWR(
    buildAdminDocumentRenderSettingsKey(enabled),
    () => service.getDocumentRenderSettings(),
    { keepPreviousData: true, revalidateOnFocus: false },
  );

/**
 * Polled, unlike the settings: `refreshWhenHidden` stays off so a backgrounded admin tab stops
 * asking the sidecar how it is.
 */
export const useAdminDocumentRenderStatus = (
  enabled: boolean,
  service: AdminDocumentRenderSettingsService,
) =>
  useClientDataSWR(
    buildAdminDocumentRenderStatusKey(enabled),
    () => service.getDocumentRenderStatus(),
    {
      keepPreviousData: true,
      refreshInterval: DOCUMENT_RENDER_STATUS_REFRESH_MS,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
    },
  );

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
