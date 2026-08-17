'use client';

import { useCallback, useEffect, useRef } from 'react';

import type { IdentityProviderPersistRequest, IdentityProviderPersistResult } from './persist';
import {
  createIdentityProviderPersistGate,
  IDENTITY_PROVIDER_AUTOSAVE_DEBOUNCE_MS,
} from './persist';

export const useIdentityProviderAutosave = ({
  persistRef,
}: {
  persistRef?: { current: (() => Promise<IdentityProviderPersistResult>) | null };
}) => {
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistGateRef = useRef(createIdentityProviderPersistGate());
  const persistLatestRef = useRef<
    (input: IdentityProviderPersistRequest) => Promise<IdentityProviderPersistResult>
  >(async () => 'clean');

  const setPersist = (
    persist: (input: IdentityProviderPersistRequest) => Promise<IdentityProviderPersistResult>,
  ) => {
    persistLatestRef.current = persist;
  };

  const cancelScheduledAutosave = () => {
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  };

  const enqueuePersist = (request: IdentityProviderPersistRequest) =>
    persistGateRef.current.enqueue(
      request,
      (next) => persistLatestRef.current(next),
      cancelScheduledAutosave,
    );

  const flushAutosave = useCallback(async (): Promise<IdentityProviderPersistResult> => {
    return enqueuePersist({ includeSecret: false, silent: true });
    // enqueuePersist reads persistLatestRef; the gate is stable.
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      autosaveTimerRef.current = null;
      void flushAutosave();
    }, IDENTITY_PROVIDER_AUTOSAVE_DEBOUNCE_MS);
  }, [flushAutosave]);

  useEffect(() => {
    if (!persistRef) return;
    persistRef.current = flushAutosave;
    return () => {
      persistRef.current = null;
    };
  }, [flushAutosave, persistRef]);

  useEffect(
    () => () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    },
    [],
  );

  return { enqueuePersist, flushAutosave, scheduleAutosave, setPersist };
};
