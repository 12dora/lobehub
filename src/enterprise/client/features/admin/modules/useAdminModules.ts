'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  ADMIN_MODULES_SWR_KEY,
  type AdminModulesService,
  adminModulesService,
  type AdminModulesState,
  type AdminModulesUpdateInput,
} from '@/enterprise/client/services/adminModules';
import { mutate, useClientDataSWR } from '@/libs/swr';

/** Restart convergence budget — a container restart plus migrations, with slack. */
export const MODULE_RESTART_TIMEOUT_MS = 120_000;
/** How often the page re-asks whether the instance is back. */
export const MODULE_RESTART_POLL_MS = 3000;

export type ModuleRestartPhase = 'accepted' | 'activated' | 'failed' | 'idle';

export const useAdminModules = (
  enabled: boolean,
  service: AdminModulesService = adminModulesService,
) =>
  useClientDataSWR<AdminModulesState>(enabled ? ADMIN_MODULES_SWR_KEY : null, () => service.get(), {
    keepPreviousData: true,
    revalidateOnFocus: false,
  });

/** Invalidate the one shared modules cache (app-scoped mutate — the global `swr` one is a no-op here). */
export const refreshAdminModules = () => mutate(ADMIN_MODULES_SWR_KEY);

/**
 * Did this save fail because someone else saved first?
 *
 * Only that answer justifies discarding the operator's draft: the revision it was computed
 * against is gone. Network failures, permission denials and cancelled reauth all leave the
 * server untouched, so the draft is still valid and still theirs.
 */
export const isModuleRevisionConflict = (error: unknown): boolean =>
  mapEnterpriseError(error)?.code === PLATFORM_ERROR_CODES.PLATFORM_REVISION_CONFLICT;

export interface UseModuleRestartResult {
  phase: ModuleRestartPhase;
  /** Ask this instance to restart, then wait for it to come back. */
  request: () => Promise<void>;
  reset: () => void;
}

/**
 * Three-state restart driver, mirroring the identity-provider restart:
 * `accepted` while we wait, `activated` once the instance answers again with nothing pending,
 * `failed` on a terminal error or when the budget runs out. Never leaves the button spinning
 * forever — an operator has to know whether to go restart the container themselves.
 */
export const useModuleRestart = (
  service: AdminModulesService = adminModulesService,
): UseModuleRestartResult => {
  const [phase, setPhase] = useState<ModuleRestartPhase>('idle');
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const reset = useCallback(() => {
    clearTimers();
    setPhase('idle');
  }, [clearTimers]);

  const request = useCallback(async () => {
    clearTimers();
    setPhase('accepted');
    try {
      await service.requestRestart();
    } catch {
      setPhase('failed');
      return;
    }

    const deadline = Date.now() + MODULE_RESTART_TIMEOUT_MS;
    const poll = async () => {
      if (Date.now() >= deadline) {
        setPhase('failed');
        return;
      }
      try {
        const next = await service.get();
        if (next.pendingRestart.length === 0) {
          setPhase('activated');
          await refreshAdminModules();
          return;
        }
      } catch {
        // The instance is expected to be unreachable while it comes back — keep waiting.
      }
      timers.current.push(setTimeout(() => void poll(), MODULE_RESTART_POLL_MS));
    };

    timers.current.push(setTimeout(() => void poll(), MODULE_RESTART_POLL_MS));
  }, [clearTimers, service]);

  return { phase, request, reset };
};

export type { AdminModulesState, AdminModulesUpdateInput };
