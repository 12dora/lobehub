'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import {
  type IdentityProviderCreateDraftSeed,
  parseIdentityProviderJsonObject,
  resolveIdentityProviderRevisionRefresh,
} from './controller';
import type { IdentityProviderStep } from './IdentityProviderWizardNavigation';
import type { EditableDraft } from './steps';
import { useDingTalkCorpCapture } from './useDingTalkCorpCapture';
import { useIdentityProviderTestResult } from './useIdentityProviders';
import { useIdentityProviderTestWait } from './useIdentityProviderTestWait';
import { useUnsavedIdentityProviderGuard } from './useUnsavedIdentityProviderGuard';
import { DEFAULT_IDENTITY_PROVIDER_SEED, fromProvider, fromSeed } from './wizardDraft';

type DiscoveryResult = Awaited<ReturnType<typeof adminIdentityProvidersService.discover>> | null;

/** The revision-scoped identity of one safe-login / capture run (ASI-009). */
export interface IdentityProviderTestAttempt {
  id: string;
  revision: number;
  startedAt: number;
}

export interface IdentityProviderWizardStateOptions {
  createSeed?: IdentityProviderCreateDraftSeed;
  onDirtyChange: (dirty: boolean) => void;
  provider?: PlatformIdentityProviderDraft;
  secretDirtyRef?: { current: boolean };
  t: TFunction<'admin'>;
}

/**
 * Everything the wizard *holds*: the draft under edit, the session state of one safe-login run,
 * and the bookkeeping that keeps both honest across a server revision change.
 *
 * It lives apart from the wizard component because none of it is presentation — the component
 * reads this bag, derives a publish gate from it (`wizardReadiness`), and renders. The rules that
 * used to be scattered between eighteen `useState` calls and the JSX are each in one place now:
 *
 * - a new server revision re-seeds the draft AND drops the session test signal, because a success
 *   for revision N must not keep 发布 enabled at N+1;
 * - `preserveDraftOnRefreshRef` is how a save we made ourselves refreshes the revision without
 *   throwing away what the operator has typed since;
 * - dirtiness is reported outward (modal close guard) and to `secretDirtyRef` (the silent
 *   non-secret autosave is not allowed to run while a secret is pending).
 */
export const useIdentityProviderWizardState = ({
  createSeed,
  onDirtyChange,
  provider,
  secretDirtyRef,
  t,
}: IdentityProviderWizardStateOptions) => {
  const [step, setStep] = useState<IdentityProviderStep>('basic');
  const [stepDirection, setStepDirection] = useState(1);
  const [draft, setDraft] = useState<EditableDraft>(() =>
    provider
      ? fromProvider(provider)
      : createSeed
        ? fromSeed(createSeed)
        : fromSeed(DEFAULT_IDENTITY_PROVIDER_SEED),
  );
  const [claimJson, setClaimJson] = useState(() => JSON.stringify(draft.claimMapping, null, 2));
  const [jsonErrors, setJsonErrors] = useState({ claims: false });
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [discovery, setDiscovery] = useState<DiscoveryResult>(null);
  const [networkValid, setNetworkValid] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Session test signal is revision-scoped (ASI-009): a success for rev N must not
  // enable Publish after a save bumps the provider to N+1.
  const [attempt, setAttempt] = useState<IdentityProviderTestAttempt | null>(null);
  const [testPolling, setTestPolling] = useState(false);
  const testResult = useIdentityProviderTestResult(attempt?.id ?? null, testPolling, () =>
    setTestPolling(false),
  );
  const testPopupRef = useRef<Window | null>(null);
  const [testWaitMessage, setTestWaitMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [conflictRefreshFailed, setConflictRefreshFailed] = useState(false);
  const lastProviderRevisionRef = useRef(provider?.revision);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const preserveDraftOnRefreshRef = useRef(false);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<Date | null>(null);
  /** Attempt id of the in-flight/last organisation capture (vs a plain safe-login test). */
  const [captureAttemptId, setCaptureAttemptId] = useState<string | null>(null);

  /**
   * What "unchanged" means for this draft. `draft` is read here but deliberately NOT a dependency:
   * the create case freezes the seed the wizard opened with, and the wizard is remounted by key
   * when it is pointed at a different provider.
   */
  const baseline = useMemo(
    () =>
      JSON.stringify(provider ? fromProvider(provider) : createSeed ? fromSeed(createSeed) : draft),
    [provider, createSeed],
  );

  const contentDirty = JSON.stringify(draft) !== baseline;
  const secretDirty = Boolean(secret) || clearSecret;
  const dirty = contentDirty || secretDirty;

  useEffect(() => {
    const refresh = resolveIdentityProviderRevisionRefresh({
      currentRevision: lastProviderRevisionRef.current,
      nextRevision: provider?.revision,
      preserveDraft: preserveDraftOnRefreshRef.current,
    });
    if (!provider || refresh === 'unchanged') return;
    lastProviderRevisionRef.current = provider.revision;
    if (refresh === 'preserve') {
      preserveDraftOnRefreshRef.current = false;
      return;
    }
    const refreshed = fromProvider(provider);
    setDraft(refreshed);
    setClaimJson(JSON.stringify(refreshed.claimMapping, null, 2));
    setJsonErrors({ claims: false });
    setSecret('');
    setClearSecret(false);
    // Drop session test state when the server revision changes — stale successes
    // must not keep Publish enabled (ASI-009 passed-stale-revision).
    setAttempt(null);
    setTestPolling(false);
  }, [provider]);

  useDingTalkCorpCapture({
    attempt,
    captureAttemptId,
    setDraft,
    t,
    testResultData: testResult.data,
  });

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (secretDirtyRef) secretDirtyRef.current = secretDirty;
  }, [secretDirty, secretDirtyRef]);

  useUnsavedIdentityProviderGuard(dirty);

  const { resetWait } = useIdentityProviderTestWait({
    attempt,
    mutate: testResult.mutate,
    onStopPolling: () => setTestPolling(false),
    onWaitMessage: setTestWaitMessage,
    t,
    testPolling,
    testPopupRef,
  });

  const patch = <Key extends keyof EditableDraft>(key: Key, value: EditableDraft[Key]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const handleClaimJsonChange = (raw: string) => {
    setClaimJson(raw);
    const parsed = parseIdentityProviderJsonObject(raw);
    setJsonErrors((current) => ({ ...current, claims: !parsed.valid }));
    if (parsed.valid)
      patch('claimMapping', parsed.value as unknown as EditableDraft['claimMapping']);
  };

  return {
    attempt,
    busy,
    captureAttemptId,
    claimJson,
    clearSecret,
    conflict,
    conflictRefreshFailed,
    contentDirty,
    dirty,
    discovery,
    draft,
    handleClaimJsonChange,
    jsonErrors,
    lastAutoSavedAt,
    lastProviderRevisionRef,
    networkValid,
    patch,
    preserveDraftOnRefreshRef,
    providerRef,
    resetWait,
    secret,
    secretDirty,
    setAttempt,
    setBusy,
    setCaptureAttemptId,
    setClearSecret,
    setConflict,
    setConflictRefreshFailed,
    setDiscovery,
    setLastAutoSavedAt,
    setNetworkValid,
    setSecret,
    setStep,
    setStepDirection,
    setTestPolling,
    setTestWaitMessage,
    step,
    stepDirection,
    testPolling,
    testPopupRef,
    testResult,
    testWaitMessage,
  };
};

export type IdentityProviderWizardState = ReturnType<typeof useIdentityProviderWizardState>;
