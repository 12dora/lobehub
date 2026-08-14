'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { withReauth } from '@/enterprise/client/services/adminAiInfraAdapter/shared';
import { lambdaClient } from '@/libs/trpc/client';

export type SharedOAuthFlowState = 'idle' | 'requesting' | 'awaiting' | 'success' | 'error';

export type SharedOAuthFlowError = 'authError' | 'codeExpired' | 'denied';

export interface SharedOAuthDeviceCode {
  deviceCode: string;
  expiresIn: number | null;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
}

export interface SharedOAuthStoreOutcome {
  published: boolean;
  publishError: string | null;
  /** Catalog revision after the store; 0 means the provider was created by this flow. */
  revision: number | null;
}

interface UseAdminSharedOAuthFlowOptions {
  /**
   * The stored connection state may have changed server-side (terminal transition, or a
   * poll that landed after the operator cancelled) — re-read it instead of trusting cache.
   */
  onStatusStale?: () => void;
  onSuccess?: (outcome: SharedOAuthStoreOutcome) => void;
  providerId: string;
}

/** Audit reason recorded for the reauth-gated store step. */
const CONNECT_REASON = 'admin shared provider account connect';

/** RFC 8628 §3.5: back off by 5s each time the authorization server says slow_down. */
const SLOW_DOWN_STEP_SECONDS = 5;

/**
 * A network blip must not throw away a user code that is still valid: keep polling and
 * only give up once this many consecutive ticks failed. Reset by any server answer.
 */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/**
 * Device-flow driver for the platform-owned (shared) provider account.
 *
 * Polls once per provider-declared interval; the success tick is the only one that
 * writes, so it may demand admin re-authentication — `withReauth` replays it with the
 * SAME device code rather than restarting the flow the operator already completed.
 *
 * Every network step is followed by a staleness check: unmount, cancel and a superseding
 * connect all invalidate the run, so a late resolution can never re-arm the timer loop
 * or write state for a flow the operator already abandoned.
 */
export const useAdminSharedOAuthFlow = ({
  providerId,
  onStatusStale,
  onSuccess,
}: UseAdminSharedOAuthFlowOptions) => {
  const [state, setState] = useState<SharedOAuthFlowState>('idle');
  const [deviceCode, setDeviceCode] = useState<SharedOAuthDeviceCode | undefined>();
  const [error, setError] = useState<SharedOAuthFlowError | undefined>();
  const [outcome, setOutcome] = useState<SharedOAuthStoreOutcome | undefined>();

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  /** Ask the caller to re-read the connection status; never fired after unmount. */
  const markStatusStale = useCallback(() => {
    if (disposedRef.current) return;
    onStatusStaleRef.current?.();
  }, []);

  const reset = useCallback(() => {
    clearTimers();
    runIdRef.current += 1;
    setState('idle');
    setDeviceCode(undefined);
    setError(undefined);
    setOutcome(undefined);
    // Cancelling does not undo whatever the server already stored — re-read it so the
    // idle card cannot claim "Not connected" for a connection that just landed.
    markStatusStale();
  }, [clearTimers, markStatusStale]);

  const connect = useCallback(async (): Promise<SharedOAuthDeviceCode | undefined> => {
    clearTimers();
    const runId = ++runIdRef.current;
    setDeviceCode(undefined);
    setError(undefined);
    setOutcome(undefined);
    setState('requesting');

    /** True once this run was cancelled, superseded, or the hook unmounted. */
    const isStale = () => disposedRef.current || runIdRef.current !== runId;

    const fail = (reason: SharedOAuthFlowError) => {
      clearTimers();
      runIdRef.current += 1;
      setError(reason);
      setState('error');
      // A failed flow may still follow a stored connection (e.g. expiry after success).
      markStatusStale();
    };

    let response;
    try {
      response = await withReauth(() =>
        lambdaClient.admin.aiProviderOAuth.initiateDeviceCode.mutate({ id: providerId }),
      );
    } catch {
      if (isStale()) return;
      fail('authError');
      return;
    }

    // Cancelled (or unmounted) while the device code was in flight: drop it silently
    // instead of arming a polling loop nobody can stop any more.
    if (isStale()) return;

    const info: SharedOAuthDeviceCode = {
      deviceCode: response.deviceCode,
      expiresIn: response.expiresIn,
      interval: response.interval,
      userCode: response.userCode,
      verificationUri: response.verificationUri,
      verificationUriComplete: response.verificationUriComplete,
    };

    /** Consecutive transient rejections; any server answer clears it. */
    let consecutiveFailures = 0;

    // Function declarations: schedule and poll are mutually recursive.
    function schedule(seconds: number) {
      if (isStale()) return;
      pollTimerRef.current = setTimeout(() => {
        void poll(seconds);
      }, seconds * 1000);
    }

    async function poll(seconds: number) {
      if (isStale()) return;

      let result;
      try {
        result = await withReauth(() =>
          lambdaClient.admin.aiProviderOAuth.pollAuthStatus.mutate({
            deviceCode: info.deviceCode,
            id: providerId,
            reason: CONNECT_REASON,
          }),
        );
      } catch {
        if (isStale()) return;
        consecutiveFailures += 1;
        // Transient blip: the user code is still valid, so keep the cadence and retry.
        if (consecutiveFailures < MAX_CONSECUTIVE_POLL_FAILURES) {
          schedule(seconds);
          return;
        }
        fail('authError');
        return;
      }

      if (isStale()) {
        // The server already stored the connection even though this run is gone —
        // surface it via a status re-read rather than dropping the outcome entirely.
        if (result.status === 'success') markStatusStale();
        return;
      }

      consecutiveFailures = 0;

      switch (result.status) {
        case 'success': {
          clearTimers();
          runIdRef.current += 1;
          const stored: SharedOAuthStoreOutcome = {
            publishError: result.publishError,
            published: result.published,
            revision: result.revision,
          };
          setOutcome(stored);
          setState('success');
          onSuccessRef.current?.(stored);
          return;
        }
        case 'denied': {
          fail('denied');
          return;
        }
        case 'expired': {
          fail('codeExpired');
          return;
        }
        case 'slow_down': {
          schedule(seconds + SLOW_DOWN_STEP_SECONDS);
          return;
        }
        default: {
          schedule(seconds);
        }
      }
    }

    setDeviceCode(info);
    setState('awaiting');

    if (info.expiresIn) {
      expiryTimerRef.current = setTimeout(() => {
        if (isStale()) return;
        fail('codeExpired');
      }, info.expiresIn * 1000);
    }

    schedule(info.interval);

    return info;
  }, [clearTimers, markStatusStale, providerId]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      // Invalidate the running flow as well: an awaited call that resolves after unmount
      // must not re-arm the loop (the cleared timers would otherwise come straight back).
      runIdRef.current += 1;
      clearTimers();
    };
  }, [clearTimers]);

  return { connect, deviceCode, error, outcome, reset, state };
};
