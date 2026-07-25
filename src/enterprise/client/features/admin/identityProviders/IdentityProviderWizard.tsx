'use client';

import { DEFAULT_IDP_BUTTON_LABEL, type PlatformIdentityProviderDraft } from '@lobechat/types';
import { copyToClipboard, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import { openReasonModal } from '../users/modals/openReasonModal';
import {
  classifyIdentityProviderWorkflowError,
  type IdentityProviderCreateDraftSeed,
  IdentityProviderTestPopupBlockedError,
  isIdentityProviderDraftWorkflowReady,
  openIdentityProviderTestPopup,
  parseIdentityProviderJsonObject,
  resolveIdentityProviderRevisionRefresh,
} from './controller';
import { IdentityProviderConflictAlert } from './IdentityProviderConflictAlert';
import {
  IDENTITY_PROVIDER_STEPS,
  type IdentityProviderStep,
  type IdentityProviderStepState,
  IdentityProviderWizardNavigation,
} from './IdentityProviderWizardNavigation';
import {
  BasicStep,
  ClaimsStep,
  ClientStep,
  DiscoveryStep,
  type EditableDraft,
  PolicyStep,
  PublishStep,
} from './steps';
import { identityProviderStyles as styles } from './styles';
import { useIdentityProviderTestResult } from './useIdentityProviders';
import { useUnsavedIdentityProviderGuard } from './useUnsavedIdentityProviderGuard';

const fromSeed = (seed: IdentityProviderCreateDraftSeed): EditableDraft => ({
  autoProvision: true,
  buttonLabel: seed.buttonLabel,
  claimMapping: structuredClone(seed.claimMapping),
  clientId: '',
  displayName: '',
  domainAllowlist: [],
  groupRoleMapping: {},
  icon: null,
  issuer: '',
  providerKey: '',
  scopes: [...seed.scopes],
  type: seed.type,
  usePkce: true,
});

const fromProvider = (provider: PlatformIdentityProviderDraft): EditableDraft => ({
  autoProvision: provider.autoProvision,
  buttonLabel: provider.buttonLabel,
  claimMapping: structuredClone(provider.claimMapping),
  clientId: provider.clientId ?? '',
  displayName: provider.displayName,
  domainAllowlist: [...provider.domainAllowlist],
  // Preserve existing mapping across unrelated edits; Policy UI edits remain out of scope
  // until a dedicated group-mapping editor ships. Runtime enforces non-empty maps at login.
  groupRoleMapping: { ...provider.groupRoleMapping },
  icon: provider.icon,
  issuer: provider.issuer ?? '',
  providerKey: provider.providerKey,
  scopes: [...provider.scopes],
  type: provider.type,
  usePkce: true,
});

interface IdentityProviderWizardProps {
  authMethod: AdminReauthAuthMethod;
  callbacks?: { production: string; test: string };
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
  provider?: PlatformIdentityProviderDraft;
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
    provider,
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
          : fromSeed({
              buttonLabel: DEFAULT_IDP_BUTTON_LABEL,
              claimMapping: {
                dingtalkTitle: [],
                dingtalkUserId: [],
                email: ['email'],
                name: ['name', 'preferred_username'],
                picture: ['picture'],
                subject: ['sub'],
              },
              scopes: ['openid', 'profile', 'email'],
              type: 'generic_oidc',
              usePkce: true,
            }),
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
    const preserveDraftOnRefreshRef = useRef(false);
    const baseline = useMemo(
      () =>
        JSON.stringify(
          provider ? fromProvider(provider) : createSeed ? fromSeed(createSeed) : draft,
        ),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- baseline is fixed at mount via key remount
      [provider, createSeed],
    );
    const invalidJson = jsonErrors.claims;
    const dirty = JSON.stringify(draft) !== baseline || Boolean(secret) || clearSecret;
    const draftWorkflowReady = isIdentityProviderDraftWorkflowReady(provider);
    const sessionTestSucceeded =
      attempt != null &&
      attempt.revision === provider?.revision &&
      testResult.data?.status === 'succeeded' &&
      Boolean(testResult.data.result?.valid);
    // Authoritative readiness: current-revision session success OR server publishTestReady.
    const testSucceeded = sessionTestSucceeded || Boolean(provider?.publishTestReady);
    const publishReady =
      Boolean(provider) && draftWorkflowReady && !dirty && canPublish && testSucceeded;
    const isLastStep = step === IDENTITY_PROVIDER_STEPS.at(-1);

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

    useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
    useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

    useUnsavedIdentityProviderGuard(dirty);

    useEffect(() => {
      if (!attempt || !testPolling) return;
      const remaining = Math.max(0, 120_000 - (Date.now() - attempt.startedAt));
      const timeout = window.setTimeout(() => setTestPolling(false), remaining);
      return () => window.clearTimeout(timeout);
    }, [attempt, testPolling]);

    const patch = <Key extends keyof EditableDraft>(key: Key, value: EditableDraft[Key]) =>
      setDraft((current) => ({ ...current, [key]: value }));

    const friendlyError = (cause: unknown): string => {
      if (cause instanceof IdentityProviderTestPopupBlockedError) {
        return t('identityProviders.test.popupBlocked');
      }
      const mapped = mapEnterpriseError(cause);
      if (mapped?.code === 'PLATFORM_REVISION_CONFLICT') {
        return t('identityProviders.conflict.description');
      }
      if (mapped?.code === 'PLATFORM_SSRF_BLOCKED') {
        return t('identityProviders.errors.networkBlocked');
      }
      if (mapped?.code === 'PLATFORM_OIDC_DISCOVERY_FAILED') {
        return t('identityProviders.errors.discoveryFailed');
      }
      const workflowError = classifyIdentityProviderWorkflowError(cause);
      if (workflowError === 'draft-required') {
        return t('identityProviders.workflow.draftRequired');
      }
      if (workflowError === 'test-required') {
        return t('identityProviders.workflow.testRequired');
      }
      return t('identityProviders.errors.generic');
    };

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

    const save = () => {
      if (
        invalidJson ||
        !draft.displayName.trim() ||
        !draft.providerKey.trim() ||
        !draft.issuer ||
        !draft.clientId
      ) {
        toast.error(t('identityProviders.errors.required'));
        return;
      }
      openReasonModal({
        buildPayload: (reason) => ({ reason }),
        description: t('identityProviders.save.description'),
        onSubmit: async (payload) => {
          const { reason } = payload as { reason: string };
          await run('save', async () => {
            const secretMutation = clearSecret
              ? ({ operation: 'clear' } as const)
              : secret
                ? ({ operation: 'replace', value: secret } as const)
                : ({ operation: 'keep' } as const);
            // Preserve persisted groupRoleMapping on edit; new drafts start empty.
            const policyDraft = { ...draft };
            if (provider) {
              const updated = await adminIdentityProvidersService.update({
                ...policyDraft,
                expectedRevision: provider.revision,
                id: provider.id,
                reason,
                secret: secretMutation,
              });
              setSecret('');
              setClearSecret(false);
              setConflict(false);
              await onSaved(updated);
            } else {
              const created = await adminIdentityProvidersService.create({
                ...policyDraft,
                reason,
                secret:
                  secretMutation.operation === 'keep' ? { operation: 'clear' } : secretMutation,
              });
              setSecret('');
              setClearSecret(false);
              setConflict(false);
              await onSaved(created);
            }
            toast.success(t('identityProviders.save.success'));
          });
        },
        submitLabel: t('identityProviders.actions.save'),
        targetLabel: draft.displayName || draft.providerKey || t('identityProviders.newProvider'),
        title: t('identityProviders.save.title'),
      });
    };

    // Discover alone validates network + endpoints; do not also call validateNetwork
    // (that would preflight the same discovery URL a second time).
    const discover = () =>
      void run(
        'discover',
        async () => {
          const metadata = await adminIdentityProvidersService.discover({ issuer: draft.issuer });
          setDiscovery(metadata);
          setNetworkValid(true);
        },
        false,
      );

    const startTest = () => {
      if (!provider) return;
      if (!draftWorkflowReady) {
        toast.error(t('identityProviders.workflow.draftRequired'));
        return;
      }
      openReasonModal({
        authMethod,
        buildPayload: (reason) => ({ reason }),
        onSubmit: async (payload) =>
          run('test', async () => {
            const result = await openIdentityProviderTestPopup(() =>
              adminIdentityProvidersService.testStart({
                expectedRevision: provider.revision,
                id: provider.id,
                reason: (payload as { reason: string }).reason,
              }),
            );
            setAttempt({
              id: result.attemptId,
              revision: provider.revision,
              startedAt: Date.now(),
            });
            setTestPolling(true);
          }),
        submitLabel: t('identityProviders.actions.startTest'),
        targetLabel: provider.displayName,
        title: t('identityProviders.test.title'),
      });
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
      const currentIndex = IDENTITY_PROVIDER_STEPS.indexOf(step);
      const nextIndex = IDENTITY_PROVIDER_STEPS.indexOf(next);
      if (nextIndex === currentIndex) return;
      setStepDirection(nextIndex > currentIndex ? 1 : -1);
      setStep(next);
    };

    const navigateStep = (offset: -1 | 1) => {
      const nextIndex = Math.min(
        IDENTITY_PROVIDER_STEPS.length - 1,
        Math.max(0, IDENTITY_PROVIDER_STEPS.indexOf(step) + offset),
      );
      goToStep(IDENTITY_PROVIDER_STEPS[nextIndex]);
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
      const basicComplete = Boolean(draft.displayName.trim() && draft.providerKey.trim());
      const discoveryComplete = Boolean(draft.issuer && networkValid && discovery);
      const clientComplete = Boolean(draft.clientId && (secret || provider?.secret.configured));
      const claimsComplete = !jsonErrors.claims;
      return {
        basic: basicComplete ? 'complete' : 'pending',
        claims: jsonErrors.claims ? 'error' : claimsComplete ? 'complete' : 'pending',
        client: clientComplete ? 'complete' : 'pending',
        discovery: discoveryComplete ? 'complete' : 'pending',
        policy: 'complete',
        publish:
          provider?.status === 'published' ||
          provider?.status === 'active' ||
          provider?.status === 'pending_restart'
            ? 'complete'
            : testResult.data?.status === 'failed'
              ? 'error'
              : 'pending',
      };
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

    const renderStep = () => {
      switch (step) {
        case 'basic': {
          return <BasicStep draft={draft} patch={patch} providerKeyLocked={Boolean(provider)} />;
        }
        case 'discovery': {
          return (
            <DiscoveryStep
              busy={busy}
              canTest={canTest}
              discovery={discovery}
              draft={draft}
              networkValid={networkValid}
              patch={patch}
              onDiscover={discover}
              onIssuerChange={() => {
                setNetworkValid(false);
                setDiscovery(null);
              }}
            />
          );
        }
        case 'client': {
          return (
            <ClientStep
              callbacks={callbacks}
              clearSecret={clearSecret}
              draft={draft}
              patch={patch}
              secret={secret}
              secretConfigured={Boolean(provider?.secret.configured)}
              secretUpdatedAt={provider?.secret.updatedAt}
              setClearSecret={setClearSecret}
              setSecret={setSecret}
              onCopyUrl={copyUrl}
            />
          );
        }
        case 'claims': {
          return (
            <ClaimsStep
              claimJson={claimJson}
              invalidJson={jsonErrors.claims}
              onClaimJsonChange={handleClaimJsonChange}
            />
          );
        }
        case 'policy': {
          return <PolicyStep draft={draft} patch={patch} />;
        }
        case 'publish': {
          return (
            <PublishStep
              attempt={attempt}
              busy={busy}
              canPublish={canPublish}
              canTest={canTest}
              dirty={dirty}
              draftWorkflowReady={draftWorkflowReady}
              hasProvider={Boolean(provider)}
              resultError={Boolean(testResult.error)}
              testResult={testResult.data}
              testSucceeded={testSucceeded}
              onRetryResult={() => void testResult.mutate()}
              onStartTest={startTest}
            />
          );
        }
      }
    };

    const typeLabel =
      (provider?.type ?? draft.type) === 'authentik'
        ? 'Authentik'
        : t('identityProviders.templates.genericOidc.label');

    return (
      <div
        className={embedded ? styles.stack : styles.panel}
        data-testid="identity-provider-wizard"
      >
        <Flexbox horizontal align="center" gap={8} justify="space-between">
          <Text type="secondary">
            {provider ? typeLabel : `${t('identityProviders.newProvider')} · ${typeLabel}`}
          </Text>
          <Flexbox horizontal align="center" gap={8}>
            {dirty ? <Text type="secondary">{t('identityProviders.unsaved')}</Text> : null}
            <Tag>
              {t(`identityProviders.values.providerStatus.${provider?.status ?? 'draft'}` as never)}
            </Tag>
          </Flexbox>
        </Flexbox>
        <IdentityProviderWizardNavigation
          stepStates={stepStates}
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
            {renderStep()}
          </m.div>
        </AnimatePresence>
        <Flexbox horizontal justify="space-between">
          <Button disabled={step === IDENTITY_PROVIDER_STEPS[0]} onClick={() => navigateStep(-1)}>
            {t('identityProviders.actions.previous')}
          </Button>
          <Flexbox horizontal gap={8}>
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
