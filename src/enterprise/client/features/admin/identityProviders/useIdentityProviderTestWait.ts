'use client';

import { toast } from '@lobehub/ui/base-ui';
import type { TFunction } from 'i18next';
import type { MutableRefObject } from 'react';
import { useEffect, useRef } from 'react';

import { IDENTITY_PROVIDER_TEST_MESSAGE_TYPE, isIdentityProviderTestTerminal } from './controller';

interface UseIdentityProviderTestWaitInput {
  attempt: { id: string; startedAt: number } | null;
  mutate: () => Promise<unknown>;
  onStopPolling: () => void;
  onWaitMessage: (message: string | null) => void;
  t: TFunction<'admin'>;
  testPolling: boolean;
  testPopupRef: MutableRefObject<Window | null>;
}

export const useIdentityProviderTestWait = ({
  attempt,
  mutate,
  onStopPolling,
  onWaitMessage,
  t,
  testPolling,
  testPopupRef,
}: UseIdentityProviderTestWaitInput) => {
  const testWaitSettledRef = useRef(false);
  const mutateRef = useRef(mutate);
  mutateRef.current = mutate;
  const onStopPollingRef = useRef(onStopPolling);
  onStopPollingRef.current = onStopPolling;
  const onWaitMessageRef = useRef(onWaitMessage);
  onWaitMessageRef.current = onWaitMessage;

  const resetWait = () => {
    testWaitSettledRef.current = false;
  };

  useEffect(() => {
    if (!attempt || !testPolling) return;

    let cancelled = false;
    const watchedAttemptId = attempt.id;

    const readStatus = (latest: unknown): string | undefined =>
      latest && typeof latest === 'object' && 'status' in latest
        ? (latest as { status?: string }).status
        : undefined;

    const finishWait = (message: string | null) => {
      if (cancelled || testWaitSettledRef.current) return;
      testWaitSettledRef.current = true;
      onStopPollingRef.current();
      if (!message) return;
      onWaitMessageRef.current(message);
      toast.info(message);
    };

    const stopIfTerminal = (latest: unknown): boolean => {
      const status = readStatus(latest);
      if (!status || !isIdentityProviderTestTerminal(status)) return false;
      testWaitSettledRef.current = true;
      onStopPollingRef.current();
      return true;
    };

    const onMessage = (event: MessageEvent) => {
      if (cancelled) return;
      if (event.origin !== window.location.origin) return;
      if (event.source !== testPopupRef.current) return;
      const data = event.data as { type?: unknown } | null;
      if (!data || data.type !== IDENTITY_PROVIDER_TEST_MESSAGE_TYPE) return;
      void Promise.resolve(mutateRef.current())
        .then((latest) => {
          if (cancelled || watchedAttemptId !== attempt.id) return;
          stopIfTerminal(latest);
        })
        .catch(() => {
          // Keep polling — a failed revalidate is not a completed login.
        });
    };

    window.addEventListener('message', onMessage);

    let closedInFlight = false;
    const closedTimer = window.setInterval(() => {
      const popup = testPopupRef.current;
      if (!popup?.closed || closedInFlight || testWaitSettledRef.current || cancelled) return;
      closedInFlight = true;
      testPopupRef.current = null;
      window.clearInterval(closedTimer);
      void Promise.resolve(mutateRef.current())
        .then((latest) => {
          if (cancelled || watchedAttemptId !== attempt.id) return;
          if (stopIfTerminal(latest)) return;
          finishWait(t('identityProviders.test.windowClosed'));
        })
        .catch(() => {
          if (cancelled || watchedAttemptId !== attempt.id) return;
          finishWait(t('identityProviders.test.windowClosed'));
        });
    }, 1000);

    const remaining = Math.max(0, 120_000 - (Date.now() - attempt.startedAt));
    const timeout = window.setTimeout(() => {
      finishWait(t('identityProviders.test.timeout'));
    }, remaining);

    return () => {
      cancelled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(closedTimer);
      window.clearTimeout(timeout);
    };
  }, [attempt, t, testPolling]);

  return { resetWait };
};
