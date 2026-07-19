'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  type AcceptedIdentityProviderRestart,
  acceptIdentityProviderRestart,
  type IdentityProviderRestartPhase,
  resolveIdentityProviderRestartPhase,
} from './controller';

interface RestartStatus {
  active: { allFreshInstancesActive: boolean };
  pendingRestart: boolean;
  restart: { supported: boolean };
  targetIdentityRevision: string | null;
}

interface UseIdentityProviderRestartLifecycleInput {
  error: unknown;
  status?: RestartStatus;
}

interface RestartPrepared {
  expectedIdentityRevision: string;
  requestId: string;
}

interface RestartAcceptedResponse {
  accepted: boolean;
  acceptedAt: Date;
  expectedIdentityRevision: string;
  requestId: string;
}

export const useIdentityProviderRestartLifecycle = ({
  error,
  status,
}: UseIdentityProviderRestartLifecycleInput) => {
  const [attempt, setAttempt] = useState<AcceptedIdentityProviderRestart | null>(null);
  const [phase, setPhase] = useState<IdentityProviderRestartPhase>('idle');

  const accept = useCallback(
    (prepared: RestartPrepared, response: RestartAcceptedResponse): boolean => {
      const accepted = acceptIdentityProviderRestart(prepared, response);
      if (!accepted) {
        setAttempt(null);
        setPhase('failed');
        return false;
      }
      setAttempt(accepted);
      setPhase('accepted');
      return true;
    },
    [],
  );

  const fail = useCallback(() => {
    setAttempt(null);
    setPhase('failed');
  }, []);

  const retry = useCallback((rerun: () => void) => {
    setAttempt(null);
    setPhase('idle');
    rerun();
  }, []);

  useEffect(() => {
    setPhase((current) =>
      resolveIdentityProviderRestartPhase({
        attempt,
        error,
        now: Date.now(),
        phase: current,
        status,
      }),
    );
  }, [attempt, error, status]);

  useEffect(() => {
    if (phase !== 'accepted' || !attempt) return;
    const remaining = Math.max(0, attempt.deadlineAt - Date.now());
    const timeout = window.setTimeout(() => setPhase('failed'), remaining);
    return () => window.clearTimeout(timeout);
  }, [attempt, phase]);

  return { accept, attempt, fail, phase, retry };
};
