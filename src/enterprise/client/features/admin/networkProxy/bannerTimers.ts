'use client';

import { useEffect, useRef, useState } from 'react';

/** How long the "it came back on its own" confirmation stays before it gets out of the way. */
const SELF_HEALED_VISIBLE_MS = 8000;

/** Whole seconds until `at`, ticking down once a second without touching the network. */
export const useCountdown = (at: string | null | undefined): number => {
  const target = at ? Date.parse(at) : Number.NaN;
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!Number.isFinite(target)) {
      setSeconds(0);
      return;
    }
    const compute = () => Math.max(0, Math.ceil((target - Date.now()) / 1000));
    setSeconds(compute());
    const timer = setInterval(() => setSeconds(compute()), 1000);
    return () => clearInterval(timer);
  }, [target]);

  return seconds;
};

const ID_SEPARATOR = '\u0000';

const splitIds = (key: string): string[] => (key ? key.split(ID_SEPARATOR) : []);

/**
 * `true` for one moment after an engine the supervisor was *automatically* retrying comes back
 * up, so the admin who saw the recovery banner learns it worked instead of just finding it gone.
 *
 * Tracked **per instance id**, because a fleet recovers one machine at a time: counting healthy
 * instances instead would let a neighbour that was up all along stand in for the one that was
 * actually being retried. An id only earns the confirmation by being seen healing and then
 * turning up live itself; an id that leaves the list was not repaired, it just stopped answering.
 *
 * `suppressed` keeps the green line off the page while another instance still needs a human —
 * "recovered" next to "not running" reads as a contradiction.
 */
export const useSelfHealed = (
  healingIds: string[],
  liveIds: string[],
  knownIds: string[],
  suppressed: boolean,
): boolean => {
  const pending = useRef(new Set<string>());
  const [healedAt, setHealedAt] = useState<number | null>(null);
  // Arrays are rebuilt every render; the joined form is what the effect can actually depend on.
  const healingKey = healingIds.join(ID_SEPARATOR);
  const liveKey = liveIds.join(ID_SEPARATOR);
  const knownKey = knownIds.join(ID_SEPARATOR);

  useEffect(() => {
    const known = new Set(splitIds(knownKey));
    for (const id of pending.current) if (!known.has(id)) pending.current.delete(id);

    const healingNow = splitIds(healingKey);
    if (healingNow.length > 0) {
      for (const id of healingNow) pending.current.add(id);
      // A retry still in flight supersedes any earlier confirmation.
      setHealedAt(null);
      return;
    }

    // `delete` answers whether this id was one we were waiting on, and clears it in one step.
    const recovered = splitIds(liveKey).filter((id) => pending.current.delete(id));
    if (recovered.length > 0 && !suppressed) setHealedAt(Date.now());
  }, [healingKey, knownKey, liveKey, suppressed]);

  useEffect(() => {
    if (healedAt === null) return;
    const timer = setTimeout(() => setHealedAt(null), SELF_HEALED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [healedAt]);

  return healedAt !== null;
};
