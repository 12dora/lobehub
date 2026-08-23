'use client';

import { useCallback } from 'react';

import { createSharedOAuthDevicePoll } from './createSharedOAuthDevicePoll';
import { decidePastePollResult } from './sharedOAuthFlowDecisions';
import {
  initiateSharedOAuthDeviceCode,
  pollSharedOAuthAuthStatus,
} from './sharedOAuthFlowRequests';
import type {
  SharedOAuthApiKeyPhase,
  SharedOAuthDeviceCode,
  SharedOAuthPastePayload,
  SharedOAuthPasteSource,
  SharedOAuthStoreOutcome,
} from './sharedOAuthFlowTypes';
import { useSharedOAuthFlowRuntime } from './useSharedOAuthFlowRuntime';

export type {
  SharedOAuthApiKeyPhase,
  SharedOAuthDeviceCode,
  SharedOAuthFlowError,
  SharedOAuthFlowState,
  SharedOAuthGrantFlow,
  SharedOAuthPasteError,
  SharedOAuthPastePayload,
  SharedOAuthPasteSource,
  SharedOAuthStoreOutcome,
} from './sharedOAuthFlowTypes';

interface UseAdminSharedOAuthFlowOptions {
  /**
   * The stored connection state may have changed server-side (terminal transition, or a
   * poll that landed after the operator cancelled) — re-read it instead of trusting cache.
   */
  onStatusStale?: () => void;
  onSuccess?: (outcome: SharedOAuthStoreOutcome) => void;
  providerId: string;
}

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
  const runtime = useSharedOAuthFlowRuntime({ onStatusStale, onSuccess });
  const {
    apiKeyPhaseRef,
    apiKeySubmitIdRef,
    beginConnectRun,
    clearTimers,
    completeWithOutcome,
    deviceCodeRef,
    disposedRef,
    expiryTimerRef,
    failFlow,
    markStatusStale,
    pollTimerRef,
    runIdRef,
    setApiKeyPhase,
    setDeviceCode,
    setError,
    setState,
    setSubmitError,
    setSubmitErrorSource,
    setSubmitting,
    submittingRef,
  } = runtime;

  const connect = useCallback(async (): Promise<SharedOAuthDeviceCode | undefined> => {
    const runId = beginConnectRun();

    /** True once this run was cancelled, superseded, or the hook unmounted. */
    const isStale = () => disposedRef.current || runIdRef.current !== runId;

    let response;
    try {
      response = await initiateSharedOAuthDeviceCode(providerId);
    } catch {
      if (isStale()) return;
      failFlow('authError');
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

    const { schedule } = createSharedOAuthDevicePoll({
      clearTimers,
      completeWithOutcome,
      deviceCode: info.deviceCode,
      failFlow,
      isStale,
      markStatusStale,
      pollTimerRef,
      providerId,
      runIdRef,
    });

    setDeviceCode(info);
    deviceCodeRef.current = info.deviceCode;
    setState('awaiting');

    if (info.expiresIn) {
      expiryTimerRef.current = setTimeout(() => {
        if (isStale()) return;
        failFlow('codeExpired');
      }, info.expiresIn * 1000);
    }

    // The paste flow has nothing to poll for — the authorization code never reaches this
    // deployment; the operator submits it by hand.
    if (info.flow !== 'authorization_code_paste') schedule(info.interval);

    return info;
  }, [
    beginConnectRun,
    clearTimers,
    completeWithOutcome,
    deviceCodeRef,
    disposedRef,
    expiryTimerRef,
    failFlow,
    markStatusStale,
    pollTimerRef,
    providerId,
    runIdRef,
    setDeviceCode,
    setState,
  ]);

  /**
   * Redeem pasted material (callback URL or raw access token) against the current envelope.
   * Only an expired envelope is terminal: every other failure keeps the form open so the
   * operator can fix the paste without repeating the browser sign-in.
   */
  const submitPasted = useCallback(
    async (payload: SharedOAuthPastePayload) => {
      const code = deviceCodeRef.current;
      if (!code || submittingRef.current) return;

      /** The field this attempt came from; every error of it belongs to that field. */
      const source: SharedOAuthPasteSource =
        payload.callbackUrl === undefined ? 'token' : 'callback';

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
        let result;
        let threw = false;
        try {
          result = await pollSharedOAuthAuthStatus(providerId, code, payload);
        } catch {
          threw = true;
        }

        if (isStale()) {
          // The server stored the connection for a run nobody is watching any more: surface
          // it through a status re-read instead of writing into the current run's state.
          if (!threw && result?.status === 'success') markStatusStale();
          return;
        }

        const decision = decidePastePollResult({ result, source, threw });

        switch (decision.kind) {
          case 'success': {
            clearTimers();
            runIdRef.current += 1;
            deviceCodeRef.current = null;
            completeWithOutcome(decision.revision);
            return;
          }
          case 'expired': {
            clearTimers();
            runIdRef.current += 1;
            deviceCodeRef.current = null;
            setDeviceCode(undefined);
            // Same reason as `failFlow()`: the `finally` below cannot clear this once the run
            // it belonged to is retired, and a spinning box refuses the retry it just asked for.
            setSubmitting(false);
            setError('codeExpired');
            setState('error');
            markStatusStale();
            return;
          }
          case 'fieldError': {
            setSubmitError(decision.error);
            setSubmitErrorSource(decision.source);
            return;
          }
          case 'networkError': {
            setSubmitError('authError');
            setSubmitErrorSource(decision.source);
            return;
          }
        }
      } finally {
        // Only this run's latch: an invalidated run already released it, and clobbering it
        // would unlock a submit the newer run is running.
        if (runIdRef.current === runId) submittingRef.current = false;
        if (!isStale()) setSubmitting(false);
      }
    },
    [
      clearTimers,
      completeWithOutcome,
      deviceCodeRef,
      disposedRef,
      markStatusStale,
      providerId,
      runIdRef,
      setDeviceCode,
      setError,
      setState,
      setSubmitError,
      setSubmitErrorSource,
      setSubmitting,
      submittingRef,
    ],
  );

  const submitCallback = useCallback(
    async (callbackUrl: string) => submitPasted({ callbackUrl }),
    [submitPasted],
  );

  const submitAccessToken = useCallback(
    async (accessToken: string, extras?: { deviceId?: string }) =>
      submitPasted({ accessToken, ...extras }),
    [submitPasted],
  );

  /** The renewable paste: a chatgpt.com web session, stored as the renewal credential. */
  const submitSessionToken = useCallback(
    async (sessionToken: string, extras?: { deviceId?: string; sessionChunks?: string[] }) =>
      submitPasted({ sessionToken, ...extras }),
    [submitPasted],
  );

  /**
   * The API-key connect route, end to end: get an envelope if this run holds none, then
   * exchange the key against it.
   *
   * Both halves live here because both readings they depend on are refs, not render state:
   * whether the envelope is still live (an expiry, a denial or a terminal poll retires it
   * between renders) and whether another submit is already spending it.
   */
  const submitApiKey = useCallback(
    async (apiKey: string) => {
      // Synchronous latch: two clicks in one render both read `apiKeyPhase === 'idle'`, and
      // the second would spend the single-use grant the first is already redeeming.
      if (apiKeyPhaseRef.current !== 'idle' || submittingRef.current) return;

      /** Retired by cancel or by a newer submit; a superseded attempt may not write. */
      const submitId = ++apiKeySubmitIdRef.current;
      const setPhase = (phase: SharedOAuthApiKeyPhase) => {
        if (apiKeySubmitIdRef.current === submitId) setApiKeyPhase(phase);
      };

      // A live envelope (the box was opened from the awaiting card) is redeemed as it stands,
      // rather than discarding a device code the provider may be about to approve.
      if (!deviceCodeRef.current) {
        setPhase('requestingEnvelope');
        const info = await connect();
        // No envelope: `state` / `error` already carry the authorization or network failure,
        // and it says nothing about the key — the panel must not report a rejected key.
        if (!info || !deviceCodeRef.current) {
          setPhase('idle');
          return;
        }
      }

      setPhase('exchangingKey');
      try {
        await submitPasted({ accessToken: apiKey });
      } finally {
        setPhase('idle');
      }
    },
    [
      apiKeyPhaseRef,
      apiKeySubmitIdRef,
      connect,
      deviceCodeRef,
      setApiKeyPhase,
      submitPasted,
      submittingRef,
    ],
  );

  return {
    apiKeyPhase: runtime.apiKeyPhase,
    connect,
    deviceCode: runtime.deviceCode,
    error: runtime.error,
    outcome: runtime.outcome,
    reset: runtime.reset,
    state: runtime.state,
    submitAccessToken,
    submitApiKey,
    submitCallback,
    submitError: runtime.submitError,
    submitErrorSource: runtime.submitErrorSource,
    submitSessionToken,
    submitting: runtime.submitting,
  };
};
