'use client';

import { useEffect, useState } from 'react';

/**
 * The one gate every automatic poll in `src/enterprise/client` runs through.
 *
 * A poll only earns its cost when somebody can act on the answer. A hidden tab (another tab in
 * front, a minimised window, a phone with the screen off) and an offline tab both fail that test:
 * every tick is a request, a query and a wakeup that nobody will ever look at. Gating them here —
 * next to `ADMIN_POLL_INTERVALS` — keeps the rule in one place instead of six.
 *
 * SWR already refuses to *fetch* while hidden (`refreshWhenHidden` / `refreshWhenOffline` default
 * to `false`), so this hook is not what makes a background tab quiet. What it adds is:
 *  - the timer itself stops, instead of waking every cadence only to decide not to fetch;
 *  - the gate becomes visible in the config a call site passes (and therefore testable);
 *  - non-SWR loops (the module-restart convergence loop) can use the same rule.
 *
 * Returning to the tab is handled by SWR's focus revalidation (`revalidateOnFocus`), which fires
 * on the very same `visibilitychange` event, so a tab that comes back does not wait a full cadence
 * for fresh data.
 */
export const isTabVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** `navigator.onLine === false` is the only reliable half of the signal; treat unknown as online. */
const isBrowserOnline = (): boolean =>
  typeof navigator === 'undefined' || navigator.onLine !== false;

const isGateOpen = (): boolean => isTabVisible() && isBrowserOnline();

/**
 * `true` while this tab is visible and online. Subscribes to `visibilitychange` / `online` /
 * `offline`, so a tab coming back to the front re-renders and its polls resume immediately.
 */
export const useIsPollGateOpen = (): boolean => {
  const [open, setOpen] = useState(isGateOpen);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const sync = () => setOpen(isGateOpen());
    // The tab may have been hidden between the first render and this effect (SSR/hydration, or a
    // background-restored tab), so read once more before trusting the events.
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  return open;
};

/**
 * SWR `refreshInterval` for a gated poll: the table cadence while the tab is visible, online and
 * the caller's own condition holds — `0` (no polling at all) otherwise.
 *
 * @param interval cadence from `ADMIN_POLL_INTERVALS`
 * @param active   the call site's own condition (a job in flight, a module enabled, …)
 */
export const useVisiblePoll = (interval: number, active: boolean = true): number =>
  useIsPollGateOpen() && active ? interval : 0;

/** Non-reactive read of the whole gate, for imperative loops. */
export const isPollGateOpen = isGateOpen;

/** Fires `listener` once, the next time this tab becomes visible. Returns an unsubscribe. */
export const onceVisible = (listener: () => void): (() => void) => {
  if (typeof document === 'undefined') return () => {};
  const handler = () => {
    if (!isTabVisible()) return;
    stop();
    listener();
  };
  const stop = () => document.removeEventListener('visibilitychange', handler);
  document.addEventListener('visibilitychange', handler);
  return stop;
};
