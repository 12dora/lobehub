'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import type { IdentityProviderCallbackUrls, IdentityProviderCreateDraftSeed } from './controller';
import { IdentityProviderConflictAlert } from './IdentityProviderConflictAlert';
import IdentityProviderStatusBadge from './IdentityProviderStatusBadge';
import { IdentityProviderWizardFooter } from './IdentityProviderWizardFooter';
import {
  type IdentityProviderStep,
  type IdentityProviderStepState,
  IdentityProviderWizardNavigation,
} from './IdentityProviderWizardNavigation';
import type { IdentityProviderPersistResult } from './persist';
import { getIdentityProviderStatusPresentation } from './statusPresentation';
import { identityProviderStyles as styles } from './styles';
import { useIdentityProviderWizardMutations } from './useIdentityProviderWizardMutations';
import { useIdentityProviderWizardState } from './useIdentityProviderWizardState';
import { resolveDingTalkCaptureBlockedReason } from './wizardCaptureGuard';
import {
  resolveIdentityProviderWizardMessages,
  resolveIdentityProviderWizardReadiness,
} from './wizardReadiness';
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

/**
 * The identity-provider wizard: navigation, one step's body, and the action row.
 *
 * What it *holds* is `useIdentityProviderWizardState`; what it *concludes* from that (the publish
 * gate, the step list, the messages under the test button) is `wizardReadiness`. This component is
 * the seam between the two — it wires state into mutations and renders the result, and that is the
 * only reason for anything to be in this file.
 */
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

    const state = useIdentityProviderWizardState({
      createSeed,
      onDirtyChange,
      provider,
      secretDirtyRef,
      t,
    });
    const { draft, dirty, step, testResult } = state;
    const invalidJson = state.jsonErrors.claims;

    const {
      corpAllowlistMissing,
      draftWorkflowReady,
      fixedProtocol,
      publishReady,
      steps,
      testSucceeded,
    } = resolveIdentityProviderWizardReadiness({
      attempt: state.attempt,
      canPublish,
      dirty,
      draft,
      provider,
      testResultData: testResult.data,
    });
    const isLastStep = step === steps.at(-1);

    const {
      captureFailureMessage,
      capturePending,
      providerKeyError,
      testFailureMessage,
      typeLabel,
    } = resolveIdentityProviderWizardMessages({
      attempt: state.attempt,
      busy: state.busy,
      captureAttemptId: state.captureAttemptId,
      draft,
      fixedProtocol,
      provider,
      t,
      testPolling: state.testPolling,
      testResultData: testResult.data,
      testResultError: testResult.error,
      testWaitMessage: state.testWaitMessage,
    });

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

    const { copyUrl, discover, publish, refreshConflict, save, scheduleAutosave, startTest } =
      useIdentityProviderWizardMutations({
        authMethod,
        canCreate,
        canUpdate,
        captureBlockedReason,
        clearSecret: state.clearSecret,
        contentDirty: state.contentDirty,
        dirty,
        draft,
        draftWorkflowReady,
        invalidJson,
        lastProviderRevisionRef: state.lastProviderRevisionRef,
        onRefresh,
        onSaved,
        persistRef,
        preserveDraftOnRefreshRef: state.preserveDraftOnRefreshRef,
        provider,
        providerKeyError,
        providerRef: state.providerRef,
        resetWait: state.resetWait,
        secret: state.secret,
        secretDirty: state.secretDirty,
        setAttempt: state.setAttempt,
        setBusy: state.setBusy,
        setCaptureAttemptId: state.setCaptureAttemptId,
        setClearSecret: state.setClearSecret,
        setConflict: state.setConflict,
        setConflictRefreshFailed: state.setConflictRefreshFailed,
        setDiscovery: state.setDiscovery,
        setLastAutoSavedAt: state.setLastAutoSavedAt,
        setNetworkValid: state.setNetworkValid,
        setSecret: state.setSecret,
        setTestPolling: state.setTestPolling,
        setTestWaitMessage: state.setTestWaitMessage,
        t,
        testPopupRef: state.testPopupRef,
        testSucceeded,
      });

    const goToStep = (next: IdentityProviderStep) => {
      const currentIndex = steps.indexOf(step);
      const nextIndex = steps.indexOf(next);
      if (nextIndex === -1 || nextIndex === currentIndex) return;
      state.setStepDirection(nextIndex > currentIndex ? 1 : -1);
      state.setStep(next);
      scheduleAutosave();
    };

    const navigateStep = (offset: -1 | 1) => {
      const nextIndex = Math.min(steps.length - 1, Math.max(0, steps.indexOf(step) + offset));
      goToStep(steps[nextIndex]);
    };

    const stepStates = useMemo((): Partial<
      Record<IdentityProviderStep, IdentityProviderStepState>
    > => {
      return computeIdentityProviderStepStates({
        discovery: state.discovery,
        draft: {
          clientId: draft.clientId,
          displayName: draft.displayName,
          issuer: draft.issuer,
          providerKey: draft.providerKey,
        },
        jsonErrorsClaims: state.jsonErrors.claims,
        networkValid: state.networkValid,
        providerSecretConfigured: provider?.secret.configured,
        providerStatus: provider?.status,
        secret: state.secret,
        testResultData: testResult.data,
      });
    }, [
      state.discovery,
      draft.clientId,
      draft.displayName,
      draft.issuer,
      draft.providerKey,
      state.jsonErrors.claims,
      state.networkValid,
      provider?.secret.configured,
      provider?.status,
      state.secret,
      testResult.data,
    ]);

    const statusPresentation = getIdentityProviderStatusPresentation({
      clientId: draft.clientId,
      dingtalkAllowedCorps: draft.dingtalkAllowedCorps,
      displayName: draft.displayName,
      issuer: draft.issuer,
      providerKey: draft.providerKey,
      secret: {
        configured:
          Boolean(provider?.secret.configured && !state.clearSecret) || Boolean(state.secret),
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
        {state.conflict ? (
          <IdentityProviderConflictAlert
            refreshFailed={state.conflictRefreshFailed}
            onDiscard={onDiscard}
            onRefresh={refreshConflict}
          />
        ) : null}
        <AnimatePresence initial={false} mode="wait">
          <m.div
            animate={{ opacity: 1, x: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, x: state.stepDirection * -8 }}
            initial={reduceMotion ? false : { opacity: 0, x: state.stepDirection * 12 }}
            key={step}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
          >
            <WizardStepBody
              attempt={state.attempt}
              busy={state.busy}
              callbacks={callbacks}
              canPublish={canPublish}
              canTest={canTest}
              captureBlockedReason={captureBlockedReason}
              captureFailureMessage={captureFailureMessage}
              capturePending={capturePending}
              claimJson={state.claimJson}
              clearSecret={state.clearSecret}
              copyUrl={copyUrl}
              corpAllowlistMissing={corpAllowlistMissing}
              dirty={dirty}
              discover={discover}
              discovery={state.discovery}
              draft={draft}
              draftWorkflowReady={draftWorkflowReady}
              handleClaimJsonChange={state.handleClaimJsonChange}
              jsonErrors={state.jsonErrors}
              networkValid={state.networkValid}
              patch={state.patch}
              provider={provider}
              providerKeyError={providerKeyError}
              secret={state.secret}
              setClearSecret={state.setClearSecret}
              setDiscovery={state.setDiscovery}
              setNetworkValid={state.setNetworkValid}
              setSecret={state.setSecret}
              startTest={startTest}
              step={step}
              t={t}
              testFailureMessage={testFailureMessage}
              testResult={testResult}
              testSucceeded={testSucceeded}
            />
          </m.div>
        </AnimatePresence>
        <IdentityProviderWizardFooter
          atFirstStep={step === steps[0]}
          busy={state.busy}
          canCreate={canCreate}
          canUpdate={canUpdate}
          conflictRefreshFailed={state.conflictRefreshFailed}
          dirty={dirty}
          editing={Boolean(provider)}
          invalidJson={invalidJson}
          isLastStep={isLastStep}
          lastAutoSavedAt={state.lastAutoSavedAt}
          publishReady={publishReady}
          onNext={() => navigateStep(1)}
          onPrevious={() => navigateStep(-1)}
          onPublish={publish}
          onSave={save}
        />
      </div>
    );
  },
);

IdentityProviderWizard.displayName = 'IdentityProviderWizard';
export default IdentityProviderWizard;
