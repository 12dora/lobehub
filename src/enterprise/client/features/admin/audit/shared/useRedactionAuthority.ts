'use client';

import { useEffect, useRef } from 'react';

import { purgeAuditConversationEvidenceCaches } from './purgeConversationEvidence';
import {
  emptyRedactionAuthorityMemory,
  type RedactionAuthorityView,
  type RedactionSlots,
  reduceRedactionAuthority,
} from './redactionAuthority';

/**
 * Mount-scoped authority. R1 never loosens (resetKey / remount only).
 * R3: one purge per tightening of `effective`; latch until the effect
 * acknowledges; never cleared because a slot went in-flight.
 */
export const useRedactionAuthority = (
  slots: RedactionSlots,
  extraObserved: ReadonlyArray<string | undefined> = [],
  resetKey?: string,
): RedactionAuthorityView & { shouldPurge: boolean } => {
  const memoryRef = useRef(emptyRedactionAuthorityMemory());
  const pendingTightenRef = useRef<string | undefined>(undefined);
  const acknowledgedTightenRef = useRef<string | undefined>(undefined);
  const resetKeyRef = useRef(resetKey);

  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    memoryRef.current = emptyRedactionAuthorityMemory();
    pendingTightenRef.current = undefined;
    acknowledgedTightenRef.current = undefined;
  }

  const reduced = reduceRedactionAuthority(memoryRef.current, slots, extraObserved);
  memoryRef.current = reduced.memory;

  if (
    reduced.view.tightenTo !== undefined &&
    reduced.view.tightenTo !== acknowledgedTightenRef.current
  ) {
    pendingTightenRef.current = reduced.view.tightenTo;
  }

  const shouldPurge =
    pendingTightenRef.current !== undefined &&
    pendingTightenRef.current !== acknowledgedTightenRef.current;

  useEffect(() => {
    const pending = pendingTightenRef.current;
    if (pending === undefined || pending === acknowledgedTightenRef.current) return;
    acknowledgedTightenRef.current = pending;
    void purgeAuditConversationEvidenceCaches();
  }, [shouldPurge, reduced.view.effective]);

  return { ...reduced.view, shouldPurge };
};
