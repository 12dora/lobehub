'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { withReauth } from '@/enterprise/client/services/adminAiInfraAdapter/shared';
import { lambdaClient } from '@/libs/trpc/client';

import { decideDevicePollTick, decidePastePollResult } from './sharedOAuthFlowDecisions';

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
  | 'invalidCallback'
  | 'stateMismatch'
  | 'exchangeFailed'
  | 'accessTokenInvalid'
  /** The pasted web session is expired or revoked — it mints no access token. */
  | 'sessionInvalid'
  /** The credential works, but belongs to a client with no chatgpt.com web permission. */
  | 'tokenNotWeb'
  | 'authError';

/**
 * Which input produced the material of the failed submit. Kept WITH the error, because a
 * generic failure (network blip, unknown literal) carries no field of its own — without the
 * source it lands on the callback box even when the operator submitted an access token.
 */
export type SharedOAuthPasteSource = 'callback' | 'token';

/**
 * Phase of the API-key connect route. The two halves fail for different reasons — an envelope
 * the server refused is an authorization/network failure and says nothing about the key, only
 * a rejected exchange does — so the panel has to be able to tell them apart.
 */
export type SharedOAuthApiKeyPhase = 'idle' | 'requestingEnvelope' | 'exchangingKey';

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
  const [apiKeyPhase, setApiKeyPhaseState] = useState<SharedOAuthApiKeyPhase>('idle');

  /** Paste flow: the envelope the pasted callback URL has to be redeemed against. */
  const deviceCodeRef = useRef<string | null>(null);
  const submittingRef = useRef(false);
  /** Mirrors `apiKeyPhase` synchronously — two clicks in one render read the same state. */
  const apiKeyPhaseRef = useRef<SharedOAuthApiKeyPhase>('idle');
  /** Bumped by cancel and by every new API-key submit; a superseded one may not write. */
  const apiKeySubmitIdRef = useRef(0);
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

  const setApiKeyPhase = useCallback((phase: SharedOAuthApiKeyPhase) => {
    apiKeyPhaseRef.current = phase;
    if (!disposedRef.current) setApiKeyPhaseState(phase);
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
      let threw = false;
      try {
        result = await withReauth(() =>
          lambdaClient.admin.aiProviderOAuth.pollAuthStatus.mutate({
            deviceCode: info.deviceCode,
            id: providerId,
            reason: CONNECT_REASON,
          }),
        );
      } catch {
        threw = true;
      }

      const decision = decideDevicePollTick({
        consecutiveFailures,
        intervalSeconds: seconds,
        result,
        stale: isStale(),
        threw,
      });

      switch (decision.kind) {
        case 'success': {
          consecutiveFailures = 0;
          clearTimers();
          runIdRef.current += 1;
          const stored: SharedOAuthStoreOutcome = { revision: decision.revision };
          setOutcome(stored);
          setState('success');
          onSuccessRef.current?.(stored);
          return;
        }
        case 'fail': {
          fail(decision.reason);
          return;
        }
        case 'retry': {
          if (threw) consecutiveFailures += 1;
          else consecutiveFailures = 0;
          schedule(decision.delaySeconds);
          return;
        }
        case 'staleSuccess': {
          // The server already stored the connection even though this run is gone —
          // surface it via a status re-read rather than dropping the outcome entirely.
          markStatusStale();
          return;
        }
        case 'ignore': {
          return;
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
    async (payload: { accessToken?: string; callbackUrl?: string; sessionToken?: string }) => {
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
          result = await withReauth(() =>
            lambdaClient.admin.aiProviderOAuth.pollAuthStatus.mutate({
              deviceCode: code,
              id: providerId,
              reason: CONNECT_REASON,
              ...payload,
            }),
          );
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
            const stored: SharedOAuthStoreOutcome = { revision: decision.revision };
            setOutcome(stored);
            setState('success');
            onSuccessRef.current?.(stored);
            return;
          }
          case 'expired': {
            clearTimers();
            runIdRef.current += 1;
            deviceCodeRef.current = null;
            setDeviceCode(undefined);
            // Same reason as `fail()`: the `finally` below cannot clear this once the run it
            // belonged to is retired, and a spinning box refuses the retry it just asked for.
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

  /** The renewable paste: a chatgpt.com web session, stored as the renewal credential. */
  const submitSessionToken = useCallback(
    async (sessionToken: string) => submitPasted({ sessionToken }),
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
    [connect, setApiKeyPhase, submitPasted],
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
    apiKeyPhase,
    connect,
    deviceCode,
    error,
    outcome,
    reset,
    state,
    submitAccessToken,
    submitApiKey,
    submitCallback,
    submitError,
    submitErrorSource,
    submitSessionToken,
    submitting,
  };
};
