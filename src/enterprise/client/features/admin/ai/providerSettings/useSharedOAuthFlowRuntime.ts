'use client';

import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  SharedOAuthApiKeyPhase,
  SharedOAuthDeviceCode,
  SharedOAuthFlowError,
  SharedOAuthFlowState,
  SharedOAuthPasteError,
  SharedOAuthPasteSource,
  SharedOAuthStoreOutcome,
} from './sharedOAuthFlowTypes';

interface UseSharedOAuthFlowRuntimeOptions {
  onStatusStale?: () => void;
  onSuccess?: (outcome: SharedOAuthStoreOutcome) => void;
}

type TimerRef = RefObject<ReturnType<typeof setTimeout> | null>;

/**
 * The shared-account flow's state machine: every piece of state the flow owns, the refs that
 * decide whether a resolved call may still write into it, and the transitions more than one
 * of the flow's routes performs. The routes themselves (device connect, paste submit, API-key
 * exchange) live in `useAdminSharedOAuthFlow` and drive this.
 *
 * The refs are the load-bearing half: cancel, a superseding connect and unmount all invalidate
 * a run between renders, so every network step is followed by a ref reading rather than a
 * render-state one.
 */
export const useSharedOAuthFlowRuntime = ({
  onStatusStale,
  onSuccess,
}: UseSharedOAuthFlowRuntimeOptions) => {
  const [state, setState] = useState<SharedOAuthFlowState>('idle');
  const [deviceCode, setDeviceCode] = useState<SharedOAuthDeviceCode | undefined>();
  const [error, setError] = useState<SharedOAuthFlowError | undefined>();
  const [outcome, setOutcome] = useState<SharedOAuthStoreOutcome | undefined>();
  const [submitError, setSubmitError] = useState<SharedOAuthPasteError | undefined>();
  const [submitErrorSource, setSubmitErrorSource] = useState<SharedOAuthPasteSource | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [apiKeyPhase, setApiKeyPhaseState] = useState<SharedOAuthApiKeyPhase>('idle');

  /** Paste flow: the envelope the pasted callback URL has to be redeemed against. */
  const deviceCodeRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  /** Mirrors `apiKeyPhase` synchronously — two clicks in one render read the same state. */
  const apiKeyPhaseRef = useRef<SharedOAuthApiKeyPhase>('idle');
  /** Bumped by cancel and by every new API-key submit; a superseded one may not write. */
  const apiKeySubmitIdRef = useRef(0);
  const pollTimerRef: TimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryTimerRef: TimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumped by cancel / a new connect / unmount; every run owns the id it started with. */
  const runIdRef = useRef(0);
  /** Set by the unmount cleanup: no state write and no re-arm may survive it. */
  const disposedRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onStatusStaleRef = useRef(onStatusStale);
  onStatusStaleRef.current = onStatusStale;

  const clearTimers = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (expiryTimerRef.current) {
      clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
  }, []);

  const setApiKeyPhase = useCallback((phase: SharedOAuthApiKeyPhase) => {
    apiKeyPhaseRef.current = phase;
    if (!disposedRef.current) setApiKeyPhaseState(phase);
  }, []);

  /** Ask the caller to re-read the connection status; never fired after unmount. */
  const markStatusStale = useCallback(() => {
    if (disposedRef.current) return;
    onStatusStaleRef.current?.();
  }, []);

  /**
   * The stored outcome, published to the panel and to the caller. Reached from both routes —
   * a device poll that came back `success` and a redeemed paste — in this exact order.
   */
  const completeWithOutcome = useCallback((revision: number | null) => {
    const stored: SharedOAuthStoreOutcome = { revision };
    setOutcome(stored);
    setState('success');
    onSuccessRef.current?.(stored);
  }, []);

  /** Terminal failure of the current run, whatever observed it. */
  const failFlow = useCallback(
    (reason: SharedOAuthFlowError) => {
      clearTimers();
      runIdRef.current += 1;
      submittingRef.current = false;
      // The envelope dies with the run — expiry, denial and a terminal poll all spend it.
      // Leaving it behind let the next submit redeem a grant the provider had already
      // retired, and report the resulting rejection as a bad API key.
      deviceCodeRef.current = null;
      if (!disposedRef.current) {
        setDeviceCode(undefined);
        // The rendered submit flag belongs to the run too: `submitPasted`'s own cleanup is
        // skipped once the run is stale, which left the box spinning after a terminal failure.
        setSubmitting(false);
      }
      setError(reason);
      setState('error');
      // A failed flow may still follow a stored connection (e.g. expiry after success).
      markStatusStale();
    },
    [clearTimers, markStatusStale],
  );

  /**
   * Open a connect run: retire whatever the previous one left behind and hand back the id
   * this run owns, so every later step of it can tell whether it is still the current one.
   */
  const beginConnectRun = useCallback(() => {
    clearTimers();
    const runId = ++runIdRef.current;
    setDeviceCode(undefined);
    setError(undefined);
    setOutcome(undefined);
    setSubmitError(undefined);
    setSubmitErrorSource(undefined);
    deviceCodeRef.current = null;
    // A superseding connect retires the previous run's submit latch as well.
    submittingRef.current = false;
    setSubmitting(false);
    setState('requesting');
    return runId;
  }, [clearTimers]);

  const reset = useCallback(() => {
    clearTimers();
    runIdRef.current += 1;
    deviceCodeRef.current = null;
    // Supersede the API-key route with the flow it was driving: a submit still in flight may
    // no longer report its phase, and the box unlocks for a fresh attempt.
    apiKeySubmitIdRef.current += 1;
    setApiKeyPhase('idle');
    // Release the submit latch with the run that owned it: leaving it set until an
    // abandoned paste mutation settles blocks the flow the operator just started.
    submittingRef.current = false;
    setSubmitting(false);
    setState('idle');
    setDeviceCode(undefined);
    setError(undefined);
    setOutcome(undefined);
    setSubmitError(undefined);
    setSubmitErrorSource(undefined);
    // Cancelling does not undo whatever the server already stored — re-read it so the
    // idle card cannot claim "Not connected" for a connection that just landed.
    markStatusStale();
  }, [clearTimers, markStatusStale, setApiKeyPhase]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      // Invalidate the running flow as well: an awaited call that resolves after unmount
      // must not re-arm the loop (the cleared timers would otherwise come straight back).
      runIdRef.current += 1;
      submittingRef.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  return {
    apiKeyPhase,
    apiKeyPhaseRef,
    apiKeySubmitIdRef,
    beginConnectRun,
    clearTimers,
    completeWithOutcome,
    deviceCode,
    deviceCodeRef,
    disposedRef,
    error,
    expiryTimerRef,
    failFlow,
    markStatusStale,
    outcome,
    pollTimerRef,
    reset,
    runIdRef,
    setApiKeyPhase,
    setDeviceCode,
    setError,
    setState,
    setSubmitError,
    setSubmitErrorSource,
    setSubmitting,
    state,
    submitError,
    submitErrorSource,
    submitting,
    submittingRef,
  };
};

export type SharedOAuthFlowRuntime = ReturnType<typeof useSharedOAuthFlowRuntime>;
