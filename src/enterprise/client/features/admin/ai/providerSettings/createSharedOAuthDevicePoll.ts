import type { RefObject } from 'react';

import { decideDevicePollTick } from './sharedOAuthFlowDecisions';
import { pollSharedOAuthAuthStatus } from './sharedOAuthFlowRequests';
import type { SharedOAuthFlowError } from './sharedOAuthFlowTypes';

export interface SharedOAuthDevicePollContext {
  clearTimers: () => void;
  /** Publishes the stored outcome; the caller has already retired the run by then. */
  completeWithOutcome: (revision: number | null) => void;
  /** The envelope this loop polls against — captured once, never re-read. */
  deviceCode: string;
  failFlow: (reason: SharedOAuthFlowError) => void;
  /** True once this run was cancelled, superseded, or the hook unmounted. */
  isStale: () => boolean;
  markStatusStale: () => void;
  pollTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  providerId: string;
  runIdRef: RefObject<number>;
}

/**
 * The RFC 8628 polling loop of ONE device-code run.
 *
 * Created per run so the envelope and the transient-failure counter belong to it: a run that
 * was cancelled or superseded can neither re-arm the timer nor write its result, because
 * `isStale` is the run's own reading and every tick asks it twice — once before the request
 * and once after it resolves.
 */
export const createSharedOAuthDevicePoll = ({
  clearTimers,
  completeWithOutcome,
  deviceCode,
  failFlow,
  isStale,
  markStatusStale,
  pollTimerRef,
  providerId,
  runIdRef,
}: SharedOAuthDevicePollContext) => {
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
      result = await pollSharedOAuthAuthStatus(providerId, deviceCode);
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
        completeWithOutcome(decision.revision);
        return;
      }
      case 'fail': {
        failFlow(decision.reason);
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

  return { schedule };
};
