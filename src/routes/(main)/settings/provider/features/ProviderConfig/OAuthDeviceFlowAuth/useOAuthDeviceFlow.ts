'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { lambdaQuery } from '@/libs/trpc/client';

type AuthState = 'idle' | 'requesting' | 'pending_user_auth' | 'polling' | 'success' | 'error';

/**
 * Which grant the provider's connect flow uses.
 * - `device_code`: RFC 8628, the app polls while the user types a code elsewhere.
 * - `authorization_code_paste`: the user signs in in a browser and pastes the callback
 *   URL back here, because the redirect URI belongs to the provider (chatgptweb).
 */
export type OAuthGrantFlow = 'device_code' | 'authorization_code_paste';

/**
 * Inline errors of the paste flow. They keep the form on screen (the user can fix the
 * paste and submit again) instead of tearing the whole flow down.
 */
export type PasteSubmitError =
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
 * source it lands on the callback box even when the user submitted an access token.
 */
export type PasteSubmitSource = 'callback' | 'token';

/** Server error literal (K3) → i18n suffix used by the paste form. */
const PASTE_ERROR_MAP: Record<string, PasteSubmitError | 'expired'> = {
  access_token_invalid: 'accessTokenInvalid',
  exchange_failed: 'exchangeFailed',
  expired: 'expired',
  invalid_callback: 'invalidCallback',
  session_invalid: 'sessionInvalid',
  state_mismatch: 'stateMismatch',
  token_not_web: 'tokenNotWeb',
};

/** Seconds added to the interval each time the authorization server says slow_down. */
const SLOW_DOWN_STEP_SECONDS = 5;

/** Grace period before polling starts, so the user can read the code first. */
const POLL_START_DELAY_MS = 2000;

interface DeviceCodeInfo {
  /** Provider accepts a manually pasted access token as a fallback credential. */
  allowAccessTokenPaste?: boolean;
  deviceCode: string;
  expiresIn: number;
  /** Defaults to `device_code` when the server does not declare one. */
  flow: OAuthGrantFlow;
  interval: number;
  userCode: string;
  verificationUri: string;
  /**
   * Verification URI with the user_code pre-filled (RFC 8628 §3.3.1), offered
   * by some providers (e.g. xAI) so the user can skip typing the code.
   */
  verificationUriComplete?: string;
}

interface UseOAuthDeviceFlowOptions {
  /**
   * The stored connection may have changed server-side for a run this hook no longer owns
   * (a redemption that landed after cancel / regenerate / unmount). The credential IS stored,
   * so the caller has to re-read the connection status instead of trusting its cache.
   */
  onStatusStale?: () => void;
  onSuccess?: () => void;
  providerId: string;
}

interface UseOAuthDeviceFlowResult {
  cancelAuth: () => void;
  deviceCodeInfo?: DeviceCodeInfo;
  error?: string;
  /** Returns the device code info on success so callers can e.g. auto-open the verification page */
  startAuth: () => Promise<DeviceCodeInfo | undefined>;
  state: AuthState;
  /** Paste flow: hand a raw access token to the server (no auto-renewal). */
  submitAccessToken: (accessToken: string) => Promise<void>;
  /** Paste flow: hand the pasted callback URL (or bare code) to the server. */
  submitCallback: (callbackUrl: string) => Promise<void>;
  /** Paste flow: recoverable submit error; the form stays open so the user can retry. */
  submitError?: PasteSubmitError;
  /** Paste flow: which input the failed submit came from, so the error lands on it. */
  submitErrorSource?: PasteSubmitSource;
  /** Paste flow: hand over a chatgpt.com web session — the renewable pasted credential. */
  submitSessionToken: (sessionToken: string) => Promise<void>;
  /** Paste flow: a submit is in flight. */
  submitting: boolean;
}

/** Reads the optional error literal off the poll union without widening the result type. */
const readPollError = (result: object): string | undefined => {
  if (!('error' in result)) return undefined;
  const code = (result as { error?: unknown }).error;
  return typeof code === 'string' ? code : undefined;
};

/**
 * Personal (per-user) OAuth connect driver.
 *
 * Every run owns an id. Cancel, regenerate and unmount all bump it, and each network step
 * re-checks it before touching a timer or React state — so a device code that resolves
 * after the user walked away can never arm a polling loop nobody can stop, and an old
 * envelope's expiry can never terminate the run that replaced it.
 */
export function useOAuthDeviceFlow({
  providerId,
  onStatusStale,
  onSuccess,
}: UseOAuthDeviceFlowOptions): UseOAuthDeviceFlowResult {
  const [state, setState] = useState<AuthState>('idle');
  const [deviceCodeInfo, setDeviceCodeInfo] = useState<DeviceCodeInfo | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<PasteSubmitError | undefined>();
  const [submitErrorSource, setSubmitErrorSource] = useState<PasteSubmitSource | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The "let the user read the code first" delay — untracked, it outlived cleanup. */
  const pollStartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deviceCodeRef = useRef<string | null>(null);
  /** Bumped by cancel / a new run / unmount; every run owns the id it started with. */
  const runIdRef = useRef(0);
  /** Set by the unmount cleanup: no state write and no re-arm may survive it. */
  const disposedRef = useRef(false);
  /**
   * Synchronous submit latch. React state cannot guard this: two clicks in the same render
   * both read `submitting === false` and both redeem the single-use grant.
   */
  const submittingRef = useRef(false);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onStatusStaleRef = useRef(onStatusStale);
  onStatusStaleRef.current = onStatusStale;

  const initiateDeviceCode = lambdaQuery.oauthDeviceFlow.initiateDeviceCode.useMutation();
  const pollAuthStatus = lambdaQuery.oauthDeviceFlow.pollAuthStatus.useMutation();
  const pollMutateAsync = pollAuthStatus.mutateAsync;
  const initiateMutateAsync = initiateDeviceCode.mutateAsync;

  const clearTimers = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    if (expiryRef.current) {
      clearTimeout(expiryRef.current);
      expiryRef.current = null;
    }
    if (pollStartRef.current) {
      clearTimeout(pollStartRef.current);
      pollStartRef.current = null;
    }
  }, []);

  /**
   * Ask the caller to re-read the connection status. Mounted-only: after unmount there is no
   * card left to correct, and the query cache belongs to whoever renders next.
   */
  const markStatusStale = useCallback(() => {
    if (disposedRef.current) return;
    onStatusStaleRef.current?.();
  }, []);

  /**
   * Retire whatever run is in flight: stop its timers, orphan its awaited calls, and drop
   * the envelope. Anything that resolves afterwards finds a run id it no longer owns.
   */
  const invalidateRun = useCallback(() => {
    clearTimers();
    runIdRef.current += 1;
    deviceCodeRef.current = null;
    submittingRef.current = false;
  }, [clearTimers]);

  const cancelAuth = useCallback(() => {
    invalidateRun();
    setState('idle');
    setDeviceCodeInfo(undefined);
    setError(undefined);
    setSubmitError(undefined);
    setSubmitErrorSource(undefined);
    setSubmitting(false);
  }, [invalidateRun]);

  const startPolling = useCallback(
    (runId: number, deviceCode: string, interval: number) => {
      const isStale = () => disposedRef.current || runIdRef.current !== runId;
      if (isStale()) return;

      setState('polling');

      /** Current cadence in seconds; slow_down re-arms the interval with a wider one. */
      let currentInterval = interval;

      const poll = async () => {
        if (isStale()) return;

        let result;
        try {
          result = await pollMutateAsync({ deviceCode, providerId });
        } catch {
          if (isStale()) return;
          invalidateRun();
          setState('error');
          setError('authError');
          return;
        }

        if (isStale()) {
          // The server stored the credential for a run nobody is watching any more (cancel,
          // regenerate, unmount). Dropping it silently left the card claiming "not connected"
          // for an account that IS connected — re-read the status instead.
          if (result.status === 'success') markStatusStale();
          return;
        }

        switch (result.status) {
          case 'success': {
            invalidateRun();
            setState('success');
            onSuccessRef.current?.();
            return;
          }
          case 'expired': {
            invalidateRun();
            setState('error');
            setError('codeExpired');
            return;
          }
          case 'denied': {
            invalidateRun();
            setState('error');
            setError('denied');
            return;
          }
          case 'error': {
            // Terminal, and NOT a poll to repeat: the grant is spent or unusable. Without
            // this case the loop would keep asking forever.
            invalidateRun();
            setState('error');
            setError(readPollError(result) === 'expired' ? 'codeExpired' : 'authError');
            return;
          }
          case 'slow_down': {
            // RFC 8628 §3.5: widen the cadence. Only re-arm if this run still owns the timer.
            if (!pollingRef.current) return;
            clearInterval(pollingRef.current);
            currentInterval += SLOW_DOWN_STEP_SECONDS;
            pollingRef.current = setInterval(() => void poll(), currentInterval * 1000);
            return;
          }
          // 'pending' — keep the cadence.
        }
      };

      pollingRef.current = setInterval(() => void poll(), currentInterval * 1000);

      // Also poll immediately
      void poll();
    },
    [invalidateRun, markStatusStale, pollMutateAsync, providerId],
  );

  const startAuth = useCallback(async () => {
    // Regenerate is a fresh run: retire the previous envelope, its expiry timer and its
    // polling loop BEFORE asking for a new code, or the old expiry kills the new one.
    invalidateRun();
    const runId = runIdRef.current;
    const isStale = () => disposedRef.current || runIdRef.current !== runId;

    setError(undefined);
    setSubmitError(undefined);
    setSubmitErrorSource(undefined);
    setSubmitting(false);
    setDeviceCodeInfo(undefined);
    setState('requesting');

    let response;
    try {
      response = await initiateMutateAsync({ providerId });
    } catch {
      if (isStale()) return;
      setState('error');
      setError('authError');
      return;
    }

    // Cancelled or unmounted while the device code was in flight: drop it silently rather
    // than arming timers for a flow the user already abandoned.
    if (isStale()) return;

    const info: DeviceCodeInfo = {
      allowAccessTokenPaste: response.allowAccessTokenPaste,
      deviceCode: response.deviceCode,
      expiresIn: response.expiresIn,
      flow: response.flow,
      interval: response.interval,
      userCode: response.userCode,
      verificationUri: response.verificationUri,
      verificationUriComplete: response.verificationUriComplete,
    };

    setDeviceCodeInfo(info);
    deviceCodeRef.current = info.deviceCode;
    setState('pending_user_auth');

    expiryRef.current = setTimeout(() => {
      if (isStale()) return;
      invalidateRun();
      setState('error');
      setError('codeExpired');
    }, info.expiresIn * 1000);

    // The paste flow has nothing to poll for: the authorization code never reaches this
    // deployment, the user brings it back by hand. Polling would only burn requests.
    if (info.flow === 'authorization_code_paste') return info;

    // Start polling after a brief delay to give user time to see the code. Tracked, so
    // cancel/unmount can clear it — otherwise it re-armed the loop after cleanup.
    pollStartRef.current = setTimeout(() => {
      pollStartRef.current = null;
      if (isStale()) return;
      startPolling(runId, info.deviceCode, info.interval);
    }, POLL_START_DELAY_MS);

    return info;
  }, [initiateMutateAsync, invalidateRun, providerId, startPolling]);

  /**
   * One-shot submit of the pasted material. Only an expired envelope is terminal — every
   * other failure keeps the form open, because the user can fix a bad paste in place.
   */
  const submitPasted = useCallback(
    async (payload: { accessToken?: string; callbackUrl?: string; sessionToken?: string }) => {
      const deviceCode = deviceCodeRef.current;
      if (!deviceCode || submittingRef.current) return;

      /** The field this attempt came from; every error of it belongs to that field. */
      const source: PasteSubmitSource = payload.callbackUrl === undefined ? 'token' : 'callback';

      // Capture BOTH: the result may only be applied while this run and this envelope are
      // still the current ones, or a late success replaces the run that superseded it.
      const runId = runIdRef.current;
      const isStale = () =>
        disposedRef.current || runIdRef.current !== runId || deviceCodeRef.current !== deviceCode;

      submittingRef.current = true;
      setSubmitError(undefined);
      setSubmitErrorSource(undefined);
      setSubmitting(true);

      try {
        const result = await pollMutateAsync({ deviceCode, providerId, ...payload });

        if (isStale()) {
          // Cancelled / regenerated while the redemption was in flight, but the server did
          // store the credential: surface it through a status re-read rather than writing
          // into the run that superseded this one.
          if (result.status === 'success') markStatusStale();
          return;
        }

        if (result.status === 'success') {
          invalidateRun();
          setState('success');
          onSuccessRef.current?.();
          return;
        }

        const mapped =
          PASTE_ERROR_MAP[readPollError(result) ?? ''] ??
          (result.status === 'expired' ? 'expired' : 'authError');

        if (mapped === 'expired') {
          invalidateRun();
          setState('error');
          setError('codeExpired');
          return;
        }

        setSubmitError(mapped);
        setSubmitErrorSource(source);
      } catch {
        if (isStale()) return;
        setSubmitError('authError');
        setSubmitErrorSource(source);
      } finally {
        // Only this run's latch: an invalidated run already reset it, and clobbering it
        // would unlock a submit the newer run is running.
        if (runIdRef.current === runId) submittingRef.current = false;
        if (!isStale()) setSubmitting(false);
      }
    },
    [invalidateRun, markStatusStale, pollMutateAsync, providerId],
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

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      // Invalidate the running flow too: an awaited call that resolves after unmount must
      // not re-arm the loop, or the cleared timers come straight back.
      runIdRef.current += 1;
      submittingRef.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  return {
    cancelAuth,
    deviceCodeInfo,
    error,
    startAuth,
    state,
    submitAccessToken,
    submitCallback,
    submitError,
    submitErrorSource,
    submitSessionToken,
    submitting,
  };
}
