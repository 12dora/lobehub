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
}

interface UseAdminSharedOAuthFlowOptions {
  onSuccess?: (outcome: SharedOAuthStoreOutcome) => void;
  providerId: string;
}

/** Audit reason recorded for the reauth-gated store step. */
const CONNECT_REASON = 'admin shared provider account connect';

/** RFC 8628 §3.5: back off by 5s each time the authorization server says slow_down. */
const SLOW_DOWN_STEP_SECONDS = 5;

/**
 * Device-flow driver for the platform-owned (shared) provider account.
 *
 * Polls once per provider-declared interval; the success tick is the only one that
 * writes, so it may demand admin re-authentication — `withReauth` replays it with the
 * SAME device code rather than restarting the flow the operator already completed.
 */
export const useAdminSharedOAuthFlow = ({
  providerId,
  onSuccess,
}: UseAdminSharedOAuthFlowOptions) => {
  const [state, setState] = useState<SharedOAuthFlowState>('idle');
  const [deviceCode, setDeviceCode] = useState<SharedOAuthDeviceCode | undefined>();
  const [error, setError] = useState<SharedOAuthFlowError | undefined>();
  const [outcome, setOutcome] = useState<SharedOAuthStoreOutcome | undefined>();

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Device code this hook currently owns; anything else is a stale/cancelled run. */
  const activeCodeRef = useRef<string | null>(null);
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

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

  const reset = useCallback(() => {
    clearTimers();
    activeCodeRef.current = null;
    setState('idle');
    setDeviceCode(undefined);
    setError(undefined);
    setOutcome(undefined);
  }, [clearTimers]);

  const connect = useCallback(async (): Promise<SharedOAuthDeviceCode | undefined> => {
    clearTimers();
    activeCodeRef.current = null;
    setDeviceCode(undefined);
    setError(undefined);
    setOutcome(undefined);
    setState('requesting');

    const fail = (reason: SharedOAuthFlowError) => {
      clearTimers();
      activeCodeRef.current = null;
      setError(reason);
      setState('error');
    };

    let response;
    try {
      response = await withReauth(() =>
        lambdaClient.admin.aiProviderOAuth.initiateDeviceCode.mutate({ id: providerId }),
      );
    } catch {
      fail('authError');
      return;
    }

    const info: SharedOAuthDeviceCode = {
      deviceCode: response.deviceCode,
      expiresIn: response.expiresIn,
      interval: response.interval,
      userCode: response.userCode,
      verificationUri: response.verificationUri,
      verificationUriComplete: response.verificationUriComplete,
    };

    const isStale = () => activeCodeRef.current !== info.deviceCode;

    // Function declarations: schedule and poll are mutually recursive.
    function schedule(seconds: number) {
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
        fail('authError');
        return;
      }

      if (isStale()) return;

      switch (result.status) {
        case 'success': {
          clearTimers();
          activeCodeRef.current = null;
          const stored: SharedOAuthStoreOutcome = {
            publishError: result.publishError,
            published: result.published,
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

    activeCodeRef.current = info.deviceCode;
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
  }, [clearTimers, providerId]);

  useEffect(
    () => () => {
      clearTimers();
      activeCodeRef.current = null;
    },
    [clearTimers],
  );

  return { connect, deviceCode, error, outcome, reset, state };
};
