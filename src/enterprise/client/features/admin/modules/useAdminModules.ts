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
import { ADMIN_POLL_INTERVALS } from '@/enterprise/client/shared/pollIntervals';
import { isTabVisible, onceVisible } from '@/enterprise/client/shared/useVisiblePoll';
import { mutate, useClientDataSWR } from '@/libs/swr';

/** Restart convergence budget — a container restart plus migrations, with slack. */
export const MODULE_RESTART_TIMEOUT_MS = 120_000;
/** How often the page re-asks whether the instance is back (visible tabs only). */
export const MODULE_RESTART_POLL_MS = ADMIN_POLL_INTERVALS.moduleRestart;

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
  const visibilityWaits = useRef<(() => void)[]>([]);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
    for (const stop of visibilityWaits.current) stop();
    visibilityWaits.current = [];
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

    let deadline = Date.now() + MODULE_RESTART_TIMEOUT_MS;

    /**
     * A hidden tab cannot show the outcome, so the loop parks instead of asking every 3s — and
     * the convergence budget parks with it: a tab that spent the restart in the background must
     * not come back to a spurious "failed". Resuming is immediate on the visibility event, so the
     * converged state is picked up the moment the operator looks again.
     */
    function parkUntilVisible() {
      const hiddenAt = Date.now();
      const stop = onceVisible(() => {
        visibilityWaits.current = visibilityWaits.current.filter((entry) => entry !== stop);
        deadline += Date.now() - hiddenAt;
        void poll();
      });
      visibilityWaits.current.push(stop);
    }

    async function poll() {
      if (!isTabVisible()) {
        parkUntilVisible();
        return;
      }
      if (Date.now() >= deadline) {
        setPhase('failed');
        return;
      }
      let converged = false;
      try {
        const next = await service.get();
        converged = next.pendingRestart.length === 0;
      } catch {
        // The instance is expected to be unreachable while it comes back — keep waiting.
      }
      // The tab can go to the background *while the request is in flight*. Re-check before doing
      // anything with the answer: neither the follow-up cache refresh nor another tick belongs to
      // a tab nobody is looking at. The answer is re-asked for on refocus.
      if (!isTabVisible()) {
        parkUntilVisible();
        return;
      }
      if (converged) {
        setPhase('activated');
        await refreshAdminModules();
        return;
      }
      timers.current.push(setTimeout(() => void poll(), MODULE_RESTART_POLL_MS));
    }

    timers.current.push(setTimeout(() => void poll(), MODULE_RESTART_POLL_MS));
  }, [clearTimers, service]);

  return { phase, request, reset };
};

export type { AdminModulesState, AdminModulesUpdateInput };
