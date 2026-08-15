'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { withReauth } from '@/enterprise/client/services/adminAiInfraAdapter/shared';
import { lambdaClient } from '@/libs/trpc/client';

export type SharedOAuthFlowState = 'idle' | 'requesting' | 'awaiting' | 'success' | 'error';

export type SharedOAuthFlowError = 'authError' | 'codeExpired' | 'denied' | 'providerStoreFailed';

/**
 * Which grant the provider's connect flow uses. `authorization_code_paste` (chatgptweb)
 * has nothing to poll for: the redirect URI belongs to the provider, so the operator signs
 * in in a browser and carries the callback URL back into this panel.
 */
export type SharedOAuthGrantFlow = 'device_code' | 'authorization_code_paste';

/**
 * Recoverable errors of a paste submit. They keep the form on screen — the operator can
 * fix the pasted value and submit again without redoing the browser sign-in.
 */
export type SharedOAuthPasteError =
  'invalidCallback' | 'stateMismatch' | 'exchangeFailed' | 'accessTokenInvalid' | 'authError';

/**
 * Which input produced the material of the failed submit. Kept WITH the error, because a
 * generic failure (network blip, unknown literal) carries no field of its own — without the
 * source it lands on the callback box even when the operator submitted an access token.
 */
export type SharedOAuthPasteSource = 'callback' | 'token';

/** Server error literal (K3) → i18n suffix used by the paste form. */
const PASTE_ERROR_MAP: Record<string, SharedOAuthPasteError | 'expired'> = {
  access_token_invalid: 'accessTokenInvalid',
  exchange_failed: 'exchangeFailed',
  expired: 'expired',
  invalid_callback: 'invalidCallback',
  state_mismatch: 'stateMismatch',
};

/**
 * Server code for "the grant was redeemed but the credentials could not be stored". It arrives
 * on a `denied` poll, so it MUST be split out: the admin did consent, and telling them the
 * provider refused authorization sends them to the wrong fix.
 */
const PROVIDER_STORE_FAILED = 'provider_store_failed';

export interface SharedOAuthDeviceCode {
  /** Provider accepts a manually pasted access token as a fallback credential. */
  allowAccessTokenPaste?: boolean;
  deviceCode: string;
  expiresIn: number | null;
  /** Defaults to `device_code` when the server does not declare one. */
  flow: SharedOAuthGrantFlow;
  interval: number;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
}

/**
 * Result of the one write the flow performs. The server applies and publishes the connected
 * account unconditionally, so a `success` poll means the credentials are committed — NOT that
 * members are served: the provider's `enabled` state is preserved and takeover requires the
 * platform-managed policy. `revision` is only kept so callers can tell a create from an update.
 */
export interface SharedOAuthStoreOutcome {
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
  const [submitError, setSubmitError] = useState<SharedOAuthPasteError | undefined>();
  const [submitErrorSource, setSubmitErrorSource] = useState<SharedOAuthPasteSource | undefined>();
  const [submitting, setSubmitting] = useState(false);

  /** Paste flow: the envelope the pasted callback URL has to be redeemed against. */
  const deviceCodeRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
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
    deviceCodeRef.current = null;
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
  }, [clearTimers, markStatusStale]);

  const connect = useCallback(async (): Promise<SharedOAuthDeviceCode | undefined> => {
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

    /** True once this run was cancelled, superseded, or the hook unmounted. */
    const isStale = () => disposedRef.current || runIdRef.current !== runId;

    const fail = (reason: SharedOAuthFlowError) => {
      clearTimers();
      runIdRef.current += 1;
      submittingRef.current = false;
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
      allowAccessTokenPaste: response.allowAccessTokenPaste,
      deviceCode: response.deviceCode,
      expiresIn: response.expiresIn,
      flow: response.flow,
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
          const stored: SharedOAuthStoreOutcome = { revision: result.revision };
          setOutcome(stored);
          setState('success');
          onSuccessRef.current?.(stored);
          return;
        }
        case 'denied': {
          // The grant is single-use and already spent, so the operator must reconnect either
          // way — but only a real denial is the provider's doing.
          fail(result.error === PROVIDER_STORE_FAILED ? 'providerStoreFailed' : 'denied');
          return;
        }
        case 'error': {
          // Terminal, and NOT a poll to repeat: the grant is spent or the envelope is
          // unusable. Falling through to `default` here re-scheduled forever.
          fail(result.error === 'expired' ? 'codeExpired' : 'authError');
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
    deviceCodeRef.current = info.deviceCode;
    setState('awaiting');

    if (info.expiresIn) {
      expiryTimerRef.current = setTimeout(() => {
        if (isStale()) return;
        fail('codeExpired');
      }, info.expiresIn * 1000);
    }

    // The paste flow has nothing to poll for — the authorization code never reaches this
    // deployment; the operator submits it by hand.
    if (info.flow !== 'authorization_code_paste') schedule(info.interval);

    return info;
  }, [clearTimers, markStatusStale, providerId]);

  /**
   * Redeem pasted material (callback URL or raw access token) against the current envelope.
   * Only an expired envelope is terminal: every other failure keeps the form open so the
   * operator can fix the paste without repeating the browser sign-in.
   */
  const submitPasted = useCallback(
    async (payload: { accessToken?: string; callbackUrl?: string }) => {
      const code = deviceCodeRef.current;
      if (!code || submittingRef.current) return;

      /** The field this attempt came from; every error of it belongs to that field. */
      const source: SharedOAuthPasteSource =
        payload.accessToken === undefined ? 'callback' : 'token';

      /**
       * Capture BOTH the run id and the envelope. Cancel / Regenerate bump the run id, and a
       * submission that started before them must not clear the newer run's timers or replace
       * its UI with its own outcome — the operator would watch a fresh flow collapse into a
       * result belonging to the one they abandoned.
       */
      const runId = runIdRef.current;
      const isStale = () =>
        disposedRef.current || runIdRef.current !== runId || deviceCodeRef.current !== code;

      submittingRef.current = true;
      setSubmitError(undefined);
      setSubmitErrorSource(undefined);
      setSubmitting(true);

      try {
        const result = await withReauth(() =>
          lambdaClient.admin.aiProviderOAuth.pollAuthStatus.mutate({
            deviceCode: code,
            id: providerId,
            reason: CONNECT_REASON,
            ...payload,
          }),
        );

        if (isStale()) {
          // The server stored the connection for a run nobody is watching any more: surface
          // it through a status re-read instead of writing into the current run's state.
          if (result.status === 'success') markStatusStale();
          return;
        }

        if (result.status === 'success') {
          clearTimers();
          runIdRef.current += 1;
          deviceCodeRef.current = null;
          const stored: SharedOAuthStoreOutcome = { revision: result.revision };
          setOutcome(stored);
          setState('success');
          onSuccessRef.current?.(stored);
          return;
        }

        const mapped =
          PASTE_ERROR_MAP[result.error ?? ''] ??
          (result.status === 'expired' ? 'expired' : 'authError');

        if (mapped === 'expired') {
          clearTimers();
          runIdRef.current += 1;
          deviceCodeRef.current = null;
          setError('codeExpired');
          setState('error');
          markStatusStale();
          return;
        }

        setSubmitError(mapped);
        setSubmitErrorSource(source);
      } catch {
        if (isStale()) return;
        setSubmitError('authError');
        setSubmitErrorSource(source);
      } finally {
        // Only this run's latch: an invalidated run already released it, and clobbering it
        // would unlock a submit the newer run is running.
        if (runIdRef.current === runId) submittingRef.current = false;
        if (!isStale()) setSubmitting(false);
      }
    },
    [clearTimers, markStatusStale, providerId],
  );

  const submitCallback = useCallback(
    async (callbackUrl: string) => submitPasted({ callbackUrl }),
    [submitPasted],
  );

  const submitAccessToken = useCallback(
    async (accessToken: string) => submitPasted({ accessToken }),
    [submitPasted],
  );

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
    connect,
    deviceCode,
    error,
    outcome,
    reset,
    state,
    submitAccessToken,
    submitCallback,
    submitError,
    submitErrorSource,
    submitting,
  };
};
