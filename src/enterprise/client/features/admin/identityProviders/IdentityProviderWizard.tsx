'use client';

import { isValidDingTalkProviderKey, type PlatformIdentityProviderDraft } from '@lobechat/types';
import { copyToClipboard, Flexbox, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import { openReasonModal } from '../users/modals/openReasonModal';
import {
  buildIdentityProviderTestFailureMessage,
  type IdentityProviderCallbackUrls,
  type IdentityProviderCreateDraftSeed,
  isFixedProtocolIdentityProviderType,
  isIdentityProviderDraftWorkflowReady,
  openIdentityProviderTestPopup,
  parseIdentityProviderJsonObject,
  resolveIdentityProviderRevisionRefresh,
} from './controller';
import { IdentityProviderConflictAlert } from './IdentityProviderConflictAlert';
import IdentityProviderStatusBadge from './IdentityProviderStatusBadge';
import {
  IDENTITY_PROVIDER_STEPS,
  type IdentityProviderStep,
  type IdentityProviderStepState,
  IdentityProviderWizardNavigation,
} from './IdentityProviderWizardNavigation';
import {
  canPersistIdentityProviderDraft,
  formatIdentityProviderAutoSavedAt,
  type IdentityProviderPersistRequest,
  type IdentityProviderPersistResult,
  resolveIdentityProviderSecretMutation,
  shouldSkipIdentityProviderPersist,
  toWritableIdentityProviderFields,
} from './persist';
import { getIdentityProviderStatusPresentation } from './statusPresentation';
import type { EditableDraft } from './steps';
import { identityProviderStyles as styles } from './styles';
import { useDingTalkCorpCapture } from './useDingTalkCorpCapture';
import { useIdentityProviderAutosave } from './useIdentityProviderAutosave';
import { useIdentityProviderTestResult } from './useIdentityProviders';
import { useUnsavedIdentityProviderGuard } from './useUnsavedIdentityProviderGuard';
import { resolveDingTalkCaptureBlockedReason } from './wizardCaptureGuard';
import { DEFAULT_IDENTITY_PROVIDER_SEED, fromProvider, fromSeed } from './wizardDraft';
import { resolveIdentityProviderWizardErrorMessage } from './wizardErrorMessage';
import { WizardStepBody } from './WizardStepBody';
import { computeIdentityProviderStepStates } from './wizardStepStates';

interface IdentityProviderWizardProps {
  authMethod: AdminReauthAuthMethod;
  callbacks?: IdentityProviderCallbackUrls;
  canCreate: boolean;
  canPublish: boolean;
  canTest: boolean;
  canUpdate: boolean;
  /** Prefill when creating from a type template. */
  createSeed?: IdentityProviderCreateDraftSeed;
  /** Drop the card chrome when hosted inside a modal. */
  embedded?: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onDiscard: () => void;
  onRefresh: () => Promise<unknown>;
  /** Called after save/publish; pass the mutation response so revision CAS stays fresh. */
  onSaved: (saved?: PlatformIdentityProviderDraft) => Promise<unknown>;
  /**
   * Flush a silent non-secret persist (step change / modal close).
   * Returns whether content was saved, already clean, or could not persist.
   */
  persistRef?: { current: (() => Promise<IdentityProviderPersistResult>) | null };
  provider?: PlatformIdentityProviderDraft;
  secretDirtyRef?: { current: boolean };
}

const IdentityProviderWizard = memo<IdentityProviderWizardProps>(
  ({
    authMethod,
    callbacks,
    canCreate,
    canPublish,
    canTest,
    canUpdate,
    createSeed,
    embedded,
    persistRef,
    provider,
    secretDirtyRef,
    onDirtyChange,
    onDiscard,
    onRefresh,
    onSaved,
  }) => {
    const { t } = useTranslation('admin');
    const reduceMotion = useReducedMotion();
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
    const [discovery, setDiscovery] = useState<Awaited<
      ReturnType<typeof adminIdentityProvidersService.discover>
    > | null>(null);
    const [networkValid, setNetworkValid] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    // Session test signal is revision-scoped (ASI-009): a success for rev N must not
    // enable Publish after a save bumps the provider to N+1.
    const [attempt, setAttempt] = useState<{
      id: string;
      revision: number;
      startedAt: number;
    } | null>(null);
    const [testPolling, setTestPolling] = useState(false);
    const testResult = useIdentityProviderTestResult(attempt?.id ?? null, testPolling, () =>
      setTestPolling(false),
    );
    const [conflict, setConflict] = useState(false);
    const [conflictRefreshFailed, setConflictRefreshFailed] = useState(false);
    const lastProviderRevisionRef = useRef(provider?.revision);
    const providerRef = useRef(provider);
    providerRef.current = provider;
    const preserveDraftOnRefreshRef = useRef(false);
    const [lastAutoSavedAt, setLastAutoSavedAt] = useState<Date | null>(null);
    /** Attempt id of the in-flight/last organisation capture (vs a plain safe-login test). */
    const [captureAttemptId, setCaptureAttemptId] = useState<string | null>(null);
    const baseline = useMemo(
      () =>
        JSON.stringify(
          provider ? fromProvider(provider) : createSeed ? fromSeed(createSeed) : draft,
        ),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- baseline is fixed at mount via key remount
      [provider, createSeed],
    );
    const invalidJson = jsonErrors.claims;
    // Kinds with a protocol-fixed issuer, endpoints and claim mapping (DingTalk) have nothing
    // to discover and nothing to remap, so those two steps are dropped instead of shown empty.
    const fixedProtocol = isFixedProtocolIdentityProviderType(provider?.type ?? draft.type);
    const contentDirty = JSON.stringify(draft) !== baseline;
    const secretDirty = Boolean(secret) || clearSecret;
    const dirty = contentDirty || secretDirty;
    const draftWorkflowReady = isIdentityProviderDraftWorkflowReady(provider);
    const sessionTestSucceeded =
      attempt != null &&
      attempt.revision === provider?.revision &&
      testResult.data?.status === 'succeeded' &&
      Boolean(testResult.data.result?.valid);
    // Authoritative readiness: current-revision session success OR server publishTestReady.
    const testSucceeded = sessionTestSucceeded || Boolean(provider?.publishTestReady);
    // Fail-closed parity with the runtime: an empty organisation allowlist lets nobody sign in,
    // so publication is blocked (the server refuses it too).
    const corpAllowlistMissing =
      (provider?.type ?? draft.type) === 'dingtalk' && draft.dingtalkAllowedCorps.length === 0;
    const publishReady =
      Boolean(provider) &&
      draftWorkflowReady &&
      !dirty &&
      !corpAllowlistMissing &&
      canPublish &&
      testSucceeded;
    const steps: readonly IdentityProviderStep[] = useMemo(
      () =>
        fixedProtocol
          ? IDENTITY_PROVIDER_STEPS.filter((item) => item !== 'discovery' && item !== 'claims')
          : IDENTITY_PROVIDER_STEPS,
      [fixedProtocol],
    );
    const isLastStep = step === steps.at(-1);

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

    useEffect(() => {
      if (!attempt || !testPolling) return;
      const remaining = Math.max(0, 120_000 - (Date.now() - attempt.startedAt));
      const timeout = window.setTimeout(() => setTestPolling(false), remaining);
      return () => window.clearTimeout(timeout);
    }, [attempt, testPolling]);

    const patch = <Key extends keyof EditableDraft>(key: Key, value: EditableDraft[Key]) =>
      setDraft((current) => ({ ...current, [key]: value }));

    // The DingTalk provider key becomes the sub-domain of the synthesized login email
    // (`<unionId>@<providerKey>.dingtalk.sso`), so it must be a DNS label — `_` or a leading /
    // trailing `-` would produce an address the runtime rejects at claim validation.
    const providerKeyError =
      fixedProtocol && draft.providerKey.trim() && !isValidDingTalkProviderKey(draft.providerKey)
        ? t('identityProviders.dingtalk.providerKeyInvalid')
        : null;

    const friendlyError = (cause: unknown): string =>
      resolveIdentityProviderWizardErrorMessage(cause, t);

    /**
     * Admin-facing explanation of a terminal safe-login / capture failure: our own instruction
     * plus the identity provider's stable error code when it reported one.
     */
    const testFailureMessage =
      testResult.data?.status === 'failed'
        ? buildIdentityProviderTestFailureMessage(
            { errorCode: testResult.data.errorCode, type: provider?.type ?? draft.type },
            (key, options) => String(t(key as never, options as never)),
          )
        : null;
    /** True while THIS wizard's organisation capture is still waiting on DingTalk. */
    const capturePending =
      busy === 'capture' || (testPolling && attempt != null && attempt.id === captureAttemptId);
    const captureFailureMessage =
      attempt != null && attempt.id === captureAttemptId ? testFailureMessage : null;
    /** Why the capture button is unavailable, or `null` when it can run. */
    const captureBlockedReason = resolveDingTalkCaptureBlockedReason(
      {
        canTest,
        capturePending,
        corpCount: draft.dingtalkAllowedCorps.length,
        dirty,
        draftWorkflowReady,
        provider,
      },
      t,
    );

    const refreshConflict = async () => {
      setConflictRefreshFailed(false);
      try {
        await onRefresh();
      } catch {
        setConflictRefreshFailed(true);
      }
    };

    const run = async (name: string, action: () => Promise<void>, propagate = true) => {
      setBusy(name);
      try {
        await action();
      } catch (cause) {
        if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
          setConflict(true);
          preserveDraftOnRefreshRef.current = true;
          await refreshConflict();
        }
        // Surface all operation failures as a toast; the wizard body stays about the form.
        toast.error(friendlyError(cause));
        if (propagate) throw cause;
      } finally {
        setBusy(null);
      }
    };

    const copyUrl = async (url: string) => {
      if (!url) return;
      try {
        await copyToClipboard(url);
        toast.success(t('identityProviders.callback.copied'));
      } catch {
        toast.error(t('identityProviders.callback.copyFailed'));
      }
    };

    const persistDraft = async (
      input: IdentityProviderPersistRequest,
    ): Promise<IdentityProviderPersistResult> => {
      const currentProvider = providerRef.current;
      const canWrite = currentProvider ? canUpdate : canCreate;
      if (
        !canWrite ||
        !canPersistIdentityProviderDraft({
          displayName: draft.displayName,
          invalidJson,
          providerKey: draft.providerKey,
          providerKeyError,
        })
      ) {
        if (!input.silent) {
          toast.error(providerKeyError ?? t('identityProviders.errors.required'));
        }
        return 'blocked';
      }
      // Never call update when neither content nor an explicit secret mutation is dirty.
      if (
        shouldSkipIdentityProviderPersist({
          contentDirty,
          includeSecret: input.includeSecret,
          secretDirty,
        })
      ) {
        return 'clean';
      }

      const writable = toWritableIdentityProviderFields(draft);
      const secretMutation = input.includeSecret
        ? resolveIdentityProviderSecretMutation({
            clearSecret,
            isCreate: !currentProvider,
            secret,
          })
        : resolveIdentityProviderSecretMutation({
            clearSecret: false,
            isCreate: !currentProvider,
            secret: '',
          });

      try {
        // Preserve local keystrokes that arrive while this request is in flight.
        preserveDraftOnRefreshRef.current = true;
        let saved: PlatformIdentityProviderDraft;
        if (currentProvider) {
          saved = await adminIdentityProvidersService.update({
            ...writable,
            expectedRevision: lastProviderRevisionRef.current ?? currentProvider.revision,
            id: currentProvider.id,
            secret: secretMutation,
          });
        } else {
          saved = await adminIdentityProvidersService.create({
            ...writable,
            secret: secretMutation.operation === 'keep' ? { operation: 'clear' } : secretMutation,
          });
        }
        lastProviderRevisionRef.current = saved.revision;
        providerRef.current = saved;
        if (input.includeSecret) {
          setSecret('');
          setClearSecret(false);
        }
        setConflict(false);
        await onSaved(saved);
        if (input.silent) {
          setLastAutoSavedAt(new Date());
        } else {
          toast.success(t('identityProviders.save.success'));
        }
        return 'saved';
      } catch (cause) {
        if (mapEnterpriseError(cause)?.code === 'PLATFORM_REVISION_CONFLICT') {
          setConflict(true);
          preserveDraftOnRefreshRef.current = true;
          await refreshConflict();
          toast.error(friendlyError(cause));
          return 'conflict';
        }
        toast.error(friendlyError(cause));
        return 'error';
      }
    };

    const { enqueuePersist, scheduleAutosave, setPersist } = useIdentityProviderAutosave({
      persistRef,
    });
    setPersist(persistDraft);

    const save = () => {
      void (async () => {
        setBusy('save');
        try {
          await enqueuePersist({ includeSecret: true, silent: false });
        } finally {
          setBusy(null);
        }
      })();
    };

    // Discover alone validates network + endpoints; do not also call validateNetwork
    // (that would preflight the same discovery URL a second time).
    const discover = () =>
      void run(
        'discover',
        async () => {
          const metadata = await adminIdentityProvidersService.discover({
            issuer: draft.issuer,
            type: draft.type,
          });
          setDiscovery(metadata);
          setNetworkValid(true);
        },
        false,
      );

    /**
     * One DingTalk/OIDC login round-trip against the isolated test callback.
     *
     * `intent: 'capture'` is the DingTalk organisation-capture entry point in the policy step:
     * the admin authorizes in DingTalk, picks the enterprise there, and the server reports the
     * resulting corpId back — administrators never type one. `intent: 'test'` is the existing
     * pre-publish safe-login test. Both are the same server flow and the same attempt record.
     */
    const startTest = (intent: 'capture' | 'test' = 'test') => {
      if (!provider) return;
      if (!draftWorkflowReady) {
        toast.error(t('identityProviders.workflow.draftRequired'));
        return;
      }
      if (intent === 'capture' && captureBlockedReason) {
        toast.error(captureBlockedReason);
        return;
      }
      // No reason prompt: this writes no configuration — it opens an isolated login window and
      // records a claim preview. The audit still captures who started it and the outcome.
      void run(
        intent === 'capture' ? 'capture' : 'test',
        async () => {
          const result = await openIdentityProviderTestPopup(() =>
            adminIdentityProvidersService.testStart({
              expectedRevision: provider.revision,
              id: provider.id,
            }),
          );
          setAttempt({
            id: result.attemptId,
            revision: provider.revision,
            startedAt: Date.now(),
          });
          setCaptureAttemptId(intent === 'capture' ? result.attemptId : null);
          setTestPolling(true);
        },
        false,
      );
    };

    const publish = () => {
      if (!provider) return;
      if (!draftWorkflowReady) {
        toast.error(t('identityProviders.workflow.draftRequired'));
        return;
      }
      if (!testSucceeded) {
        toast.error(t('identityProviders.workflow.testRequired'));
        return;
      }
      if (dirty) {
        toast.error(t('identityProviders.unsaved'));
        return;
      }
      openReasonModal({
        authMethod,
        buildPayload: (reason) => ({ reason }),
        impact: t('identityProviders.publish.impact'),
        onSubmit: async (payload) =>
          run('publish', async () => {
            const published = await adminIdentityProvidersService.publish({
              expectedRevision: provider.revision,
              id: provider.id,
              reason: (payload as { reason: string }).reason,
              requestId: crypto.randomUUID(),
            });
            await onSaved(published);
            toast.success(t('identityProviders.publish.success'));
          }),
        submitLabel: t('identityProviders.actions.publish'),
        targetLabel: provider.displayName,
        title: t('identityProviders.publish.title'),
      });
    };

    const goToStep = (next: IdentityProviderStep) => {
      const currentIndex = steps.indexOf(step);
      const nextIndex = steps.indexOf(next);
      if (nextIndex === -1 || nextIndex === currentIndex) return;
      setStepDirection(nextIndex > currentIndex ? 1 : -1);
      setStep(next);
      scheduleAutosave();
    };

    const navigateStep = (offset: -1 | 1) => {
      const nextIndex = Math.min(steps.length - 1, Math.max(0, steps.indexOf(step) + offset));
      goToStep(steps[nextIndex]);
    };

    const handleClaimJsonChange = (raw: string) => {
      setClaimJson(raw);
      const parsed = parseIdentityProviderJsonObject(raw);
      setJsonErrors((current) => ({ ...current, claims: !parsed.valid }));
      if (parsed.valid)
        patch('claimMapping', parsed.value as unknown as EditableDraft['claimMapping']);
    };

    const stepStates = useMemo((): Partial<
      Record<IdentityProviderStep, IdentityProviderStepState>
    > => {
      return computeIdentityProviderStepStates({
        discovery,
        draft: {
          clientId: draft.clientId,
          displayName: draft.displayName,
          issuer: draft.issuer,
          providerKey: draft.providerKey,
        },
        jsonErrorsClaims: jsonErrors.claims,
        networkValid,
        providerSecretConfigured: provider?.secret.configured,
        providerStatus: provider?.status,
        secret,
        testResultData: testResult.data,
      });
    }, [
      discovery,
      draft.clientId,
      draft.displayName,
      draft.issuer,
      draft.providerKey,
      jsonErrors.claims,
      networkValid,
      provider?.secret.configured,
      provider?.status,
      secret,
      testResult.data,
    ]);

    const resolvedType = provider?.type ?? draft.type;
    const typeLabel =
      resolvedType === 'authentik'
        ? 'Authentik'
        : resolvedType === 'dingtalk'
          ? t('identityProviders.templates.dingtalk.label')
          : t('identityProviders.templates.genericOidc.label');
    const statusPresentation = getIdentityProviderStatusPresentation({
      clientId: draft.clientId,
      dingtalkAllowedCorps: draft.dingtalkAllowedCorps,
      displayName: draft.displayName,
      issuer: draft.issuer,
      providerKey: draft.providerKey,
      secret: {
        configured: Boolean(provider?.secret.configured && !clearSecret) || Boolean(secret),
      },
      status: provider?.status ?? 'draft',
      type: draft.type,
    });
    const statusTag = <IdentityProviderStatusBadge presentation={statusPresentation} />;

    return (
      <div
        className={embedded ? styles.embeddedStack : styles.panel}
        data-testid="identity-provider-wizard"
      >
        {embedded ? null : (
          <Flexbox horizontal align="center" gap={8} justify="space-between">
            <Text type="secondary">
              {provider ? typeLabel : `${t('identityProviders.newProvider')} · ${typeLabel}`}
            </Text>
            <Flexbox horizontal align="center" gap={8}>
              {dirty ? <Text type="secondary">{t('identityProviders.unsaved')}</Text> : null}
              {statusTag}
            </Flexbox>
          </Flexbox>
        )}
        <IdentityProviderWizardNavigation
          extra={embedded ? statusTag : undefined}
          stepStates={stepStates}
          steps={steps}
          value={step}
          onChange={goToStep}
        />
        {conflict ? (
          <IdentityProviderConflictAlert
            refreshFailed={conflictRefreshFailed}
            onDiscard={onDiscard}
            onRefresh={refreshConflict}
          />
        ) : null}
        <AnimatePresence initial={false} mode="wait">
          <m.div
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, x: stepDirection * -8 }}
            initial={reduceMotion ? false : { opacity: 0, x: stepDirection * 12 }}
            key={step}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
          >
            <WizardStepBody
              attempt={attempt}
              busy={busy}
              callbacks={callbacks}
              canPublish={canPublish}
              canTest={canTest}
              captureBlockedReason={captureBlockedReason}
              captureFailureMessage={captureFailureMessage}
              capturePending={capturePending}
              claimJson={claimJson}
              clearSecret={clearSecret}
              copyUrl={copyUrl}
              corpAllowlistMissing={corpAllowlistMissing}
              dirty={dirty}
              discover={discover}
              discovery={discovery}
              draft={draft}
              draftWorkflowReady={draftWorkflowReady}
              handleClaimJsonChange={handleClaimJsonChange}
              jsonErrors={jsonErrors}
              networkValid={networkValid}
              patch={patch}
              provider={provider}
              providerKeyError={providerKeyError}
              secret={secret}
              setClearSecret={setClearSecret}
              setDiscovery={setDiscovery}
              setNetworkValid={setNetworkValid}
              setSecret={setSecret}
              startTest={startTest}
              step={step}
              t={t}
              testFailureMessage={testFailureMessage}
              testResult={testResult}
              testSucceeded={testSucceeded}
            />
          </m.div>
        </AnimatePresence>
        <Flexbox horizontal align="center" justify="space-between">
          <Button disabled={step === steps[0]} onClick={() => navigateStep(-1)}>
            {t('identityProviders.actions.previous')}
          </Button>
          <Flexbox horizontal align="center" gap={8}>
            {lastAutoSavedAt ? (
              <Text type="secondary">
                {t('identityProviders.save.autoSaved', {
                  time: formatIdentityProviderAutoSavedAt(lastAutoSavedAt),
                })}
              </Text>
            ) : dirty ? (
              <Text type="secondary">{t('identityProviders.unsaved')}</Text>
            ) : null}
            <Button
              loading={busy === 'save'}
              type={isLastStep ? 'default' : 'primary'}
              disabled={
                invalidJson || conflictRefreshFailed || (provider ? !canUpdate : !canCreate)
              }
              onClick={save}
            >
              {t('identityProviders.actions.save')}
            </Button>
            {isLastStep ? (
              <Button
                disabled={!publishReady}
                loading={busy === 'publish'}
                type="primary"
                onClick={publish}
              >
                {t('identityProviders.actions.publish')}
              </Button>
            ) : (
              <Button disabled={invalidJson} onClick={() => navigateStep(1)}>
                {t('identityProviders.actions.next')}
              </Button>
            )}
          </Flexbox>
        </Flexbox>
      </div>
    );
  },
);

IdentityProviderWizard.displayName = 'IdentityProviderWizard';
export default IdentityProviderWizard;
