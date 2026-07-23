'use client';

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';

import {
  type AdminReauthAuthMethod,
  AdminReauthBlockedError,
  AdminReauthCancelledError,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { cloneFromCanonical, createCanonicalSnapshot } from './payloadSnapshot';

/** Phases owned by the shared reauth/mutation submit path. */
export type AdminReauthBusyPhase = 'idle' | 'reauthing' | 'mutating';

export interface RunReauthedSubmitOptions<TPayload> {
  authMethod?: AdminReauthAuthMethod | null;
  /**
   * Map non-reauth errors to admin i18n keys.
   * Cancelled/blocked reauth are mapped by the runner itself.
   */
  mapError: (error: unknown) => string;
  onSubmit: (attemptPayload: TPayload) => Promise<void>;
  /** Runs only when still mounted after a successful mutation. */
  onSuccess: () => void | Promise<void>;
  /** Live payload — snapshotted once before reauth/mutation. */
  payload: TPayload;
}

export interface UseReauthMutationOptions {
  /**
   * Shared abort controller for this modal instance.
   * Parent openers wire onOpenChange(false) to abort immediately (Escape/close).
   */
  abortControllerRef?: MutableRefObject<AbortController | null>;
  /**
   * Finally safety net: demote only mutating|reauthing → idle.
   * Must preserve extended phases (e.g. CreateUser `success`).
   * Caller should no-op when unmounted if needed.
   */
  resetBusyPhase: () => void;
  /**
   * Phase updates during reauth/mutation (reauthing, mutating, idle on error).
   * Callers may wrap to sync extra refs (dismiss guard, phaseRef).
   * Invoked only while the modal content is still mounted.
   */
  setPhase: (phase: AdminReauthBusyPhase) => void;
}

/**
 * Shared mounted/abort lifecycle + reauth-retry submit orchestration for admin
 * danger modals. Callers keep form validation, payload shape, credentials UI,
 * and domain error mapping.
 *
 * Never logs payloads (may contain secrets).
 */
export const useReauthMutation = ({
  abortControllerRef,
  resetBusyPhase,
  setPhase,
}: UseReauthMutationOptions) => {
  const [errorKey, setErrorKey] = useState<string | null>(null);
  /** Private canonical snapshot — never passed to onSubmit. */
  const canonicalRef = useRef<unknown>(null);
  const localAbortRef = useRef<AbortController | null>(null);
  const abortRef = abortControllerRef ?? localAbortRef;
  const mountedRef = useRef(true);

  // Keep latest setters without re-creating submit/cancel callbacks every render.
  const setPhaseRef = useRef(setPhase);
  setPhaseRef.current = setPhase;
  const resetBusyPhaseRef = useRef(resetBusyPhase);
  resetBusyPhaseRef.current = resetBusyPhase;

  const setPhaseMounted = useCallback((phase: AdminReauthBusyPhase) => {
    if (!mountedRef.current) return;
    setPhaseRef.current(phase);
  }, []);

  const setErrorKeySafe = useCallback((key: string | null) => {
    if (!mountedRef.current) return;
    setErrorKey(key);
  }, []);

  const abortActive = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, [abortRef]);

  const clearCanonical = useCallback(() => {
    canonicalRef.current = null;
  }, []);

  // Complements onOpenChange(false) / Cancel: unmount must still abort + clear snapshot.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      canonicalRef.current = null;
    };
  }, [abortRef]);

  const cancelReauth = useCallback(
    (phase: string) => {
      // Only reauth is abortable; do not pretend an in-flight server mutation cancels.
      if (phase !== 'reauthing') return;
      abortActive();
      setPhaseMounted('idle');
      setErrorKeySafe('users.errors.reauthCancelled');
    },
    [abortActive, setErrorKeySafe, setPhaseMounted],
  );

  const runReauthedSubmit = useCallback(
    async <TPayload>({
      authMethod,
      mapError,
      onSubmit,
      onSuccess,
      payload,
    }: RunReauthedSubmitOptions<TPayload>) => {
      setErrorKeySafe(null);
      canonicalRef.current = createCanonicalSnapshot(payload);
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        await withAdminReauthRetry(
          async () => {
            setPhaseMounted('mutating');
            const canonical = canonicalRef.current;
            if (canonical === null || ac.signal.aborted || !mountedRef.current) {
              throw new AdminReauthCancelledError();
            }
            // Fresh clone per attempt — first call mutation cannot poison retry.
            const attemptPayload = cloneFromCanonical(canonical) as TPayload;
            await onSubmit(attemptPayload);
          },
          {
            authMethod: authMethod ?? null,
            signal: ac.signal,
            onReauthStart: () => {
              setPhaseMounted('reauthing');
            },
          },
        );
        if (!mountedRef.current) return;
        canonicalRef.current = null;
        await onSuccess();
      } catch (error) {
        if (!mountedRef.current) return;
        if (error instanceof AdminReauthCancelledError) {
          setErrorKeySafe('users.errors.reauthCancelled');
        } else if (error instanceof AdminReauthBlockedError) {
          setErrorKeySafe('users.errors.reauthBlocked');
        } else {
          setErrorKeySafe(mapError(error));
        }
        setPhaseMounted('idle');
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
        }
        if (mountedRef.current) {
          resetBusyPhaseRef.current();
        }
      }
    },
    [abortRef, setErrorKeySafe, setPhaseMounted],
  );

  return {
    abortActive,
    cancelReauth,
    clearCanonical,
    errorKey,
    runReauthedSubmit,
    setErrorKeySafe,
  };
};
