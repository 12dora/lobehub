'use client';

import { useEffect, useRef } from 'react';

import { purgeAuditConversationEvidenceCaches } from './purgeConversationEvidence';
import {
  emptyRedactionAuthorityMemory,
  type RedactionAuthorityView,
  reduceRedactionAuthority,
} from './redactionAuthority';

/**
 * Mount-scoped redaction authority. Tightens immediately, loosens only on
 * converged confirmation, purges once per (effective, disagreement) epoch.
 */
export const useRedactionAuthority = (
  sources: ReadonlyArray<string | null | undefined>,
  resetKey?: string,
): RedactionAuthorityView & { shouldPurge: boolean } => {
  const memoryRef = useRef(emptyRedactionAuthorityMemory());
  const latchedEpochRef = useRef<string | null>(null);
  const resetKeyRef = useRef(resetKey);

  if (resetKeyRef.current !== resetKey) {
    resetKeyRef.current = resetKey;
    memoryRef.current = emptyRedactionAuthorityMemory();
    latchedEpochRef.current = null;
  }

  const reduced = reduceRedactionAuthority(memoryRef.current, sources);
  memoryRef.current = reduced.memory;

  const { purgeEpoch } = reduced.view;
  const shouldPurge = purgeEpoch !== null && purgeEpoch !== latchedEpochRef.current;

  useEffect(() => {
    if (!purgeEpoch) {
      latchedEpochRef.current = null;
      return;
    }
    if (latchedEpochRef.current === purgeEpoch) return;
    latchedEpochRef.current = purgeEpoch;
    void purgeAuditConversationEvidenceCaches();
  }, [purgeEpoch]);

  return { ...reduced.view, shouldPurge };
};
