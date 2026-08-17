'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseModalPhaseGuardOptions<TPhase extends string> {
  blockEscapeWhen: readonly TPhase[];
  dismissGuardRef?: { current: { phase: TPhase } };
  initialPhase: TPhase;
  onPhaseChange?: (phase: TPhase) => void;
}

/**
 * Shared live-phase + capture-phase Escape blocker for admin danger modals.
 * `setPhase` syncs refs before re-render so a dismissal arriving in the same
 * tick already sees the new phase.
 */
export const useModalPhaseGuard = <TPhase extends string>({
  blockEscapeWhen,
  dismissGuardRef,
  initialPhase,
  onPhaseChange,
}: UseModalPhaseGuardOptions<TPhase>) => {
  const [phase, setPhaseState] = useState(initialPhase);
  const phaseRef = useRef(initialPhase);
  const blockEscapeWhenRef = useRef(blockEscapeWhen);
  blockEscapeWhenRef.current = blockEscapeWhen;

  const setPhase = useCallback(
    (next: TPhase) => {
      phaseRef.current = next;
      if (dismissGuardRef) dismissGuardRef.current.phase = next;
      setPhaseState(next);
      onPhaseChange?.(next);
    },
    [dismissGuardRef, onPhaseChange],
  );

  useEffect(() => {
    phaseRef.current = phase;
    if (dismissGuardRef) dismissGuardRef.current.phase = phase;
  }, [dismissGuardRef, phase]);

  useEffect(() => {
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!blockEscapeWhenRef.current.includes(phaseRef.current)) return;
      event.stopImmediatePropagation();
      event.stopPropagation();
    };
    document.addEventListener('keydown', blockEscape, true);
    return () => document.removeEventListener('keydown', blockEscape, true);
  }, []);

  return { phase, phaseRef, setPhase, setPhaseState };
};
