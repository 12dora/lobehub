import { isValidDingTalkProviderKey, type PlatformIdentityProviderDraft } from '@lobechat/types';
import type { TFunction } from 'i18next';

import type { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import {
  buildIdentityProviderTestFailureMessage,
  isFixedProtocolIdentityProviderType,
  isIdentityProviderDraftWorkflowReady,
} from './controller';
import {
  IDENTITY_PROVIDER_STEPS,
  type IdentityProviderStep,
} from './IdentityProviderWizardNavigation';
import type { EditableDraft } from './steps';
import type { IdentityProviderTestAttempt } from './useIdentityProviderWizardState';

type TestResultData =
  Awaited<ReturnType<typeof adminIdentityProvidersService.testResult>> | undefined;

export interface IdentityProviderWizardReadinessInput {
  attempt: IdentityProviderTestAttempt | null;
  canPublish: boolean;
  dirty: boolean;
  draft: EditableDraft;
  provider?: PlatformIdentityProviderDraft;
  testResultData: TestResultData;
}

export interface IdentityProviderWizardReadiness {
  corpAllowlistMissing: boolean;
  draftWorkflowReady: boolean;
  fixedProtocol: boolean;
  publishReady: boolean;
  steps: readonly IdentityProviderStep[];
  testSucceeded: boolean;
}

/**
 * Kinds with a protocol-fixed issuer, endpoints and claim mapping (DingTalk) have nothing to
 * discover and nothing to remap, so those two steps are dropped instead of shown empty.
 */
export const resolveIdentityProviderSteps = (
  fixedProtocol: boolean,
): readonly IdentityProviderStep[] =>
  fixedProtocol
    ? IDENTITY_PROVIDER_STEPS.filter((item) => item !== 'discovery' && item !== 'claims')
    : IDENTITY_PROVIDER_STEPS;

/**
 * The publish gate, in one place.
 *
 * Two of these clauses are the reason it is worth naming: a session test success is scoped to the
 * revision it ran against (ASI-009 — a pass at revision N cannot unlock 发布 at N+1), and an empty
 * DingTalk organisation allowlist lets nobody sign in, so publication is refused here exactly as
 * the server refuses it. `publishTestReady` is the server's own memory of a pass that outlived
 * this browser session.
 */
export const resolveIdentityProviderWizardReadiness = ({
  attempt,
  canPublish,
  dirty,
  draft,
  provider,
  testResultData,
}: IdentityProviderWizardReadinessInput): IdentityProviderWizardReadiness => {
  const fixedProtocol = isFixedProtocolIdentityProviderType(provider?.type ?? draft.type);
  const draftWorkflowReady = isIdentityProviderDraftWorkflowReady(provider);
  const sessionTestSucceeded =
    attempt != null &&
    attempt.revision === provider?.revision &&
    testResultData?.status === 'succeeded' &&
    Boolean(testResultData.result?.valid);
  // Authoritative readiness: current-revision session success OR server publishTestReady.
  const testSucceeded = sessionTestSucceeded || Boolean(provider?.publishTestReady);
  // Fail-closed parity with the runtime: an empty organisation allowlist lets nobody sign in,
  // so publication is blocked (the server refuses it too).
  const corpAllowlistMissing =
    (provider?.type ?? draft.type) === 'dingtalk' && draft.dingtalkAllowedCorps.length === 0;

  return {
    corpAllowlistMissing,
    draftWorkflowReady,
    fixedProtocol,
    publishReady:
      Boolean(provider) &&
      draftWorkflowReady &&
      !dirty &&
      !corpAllowlistMissing &&
      canPublish &&
      testSucceeded,
    steps: resolveIdentityProviderSteps(fixedProtocol),
    testSucceeded,
  };
};

export interface IdentityProviderWizardMessagesInput {
  attempt: IdentityProviderTestAttempt | null;
  busy: string | null;
  captureAttemptId: string | null;
  draft: EditableDraft;
  fixedProtocol: boolean;
  provider?: PlatformIdentityProviderDraft;
  t: TFunction<'admin'>;
  testPolling: boolean;
  testResultData: TestResultData;
  testResultError: unknown;
  testWaitMessage: string | null;
}

export interface IdentityProviderWizardMessages {
  captureFailureMessage: string | null;
  capturePending: boolean;
  providerKeyError: string | null;
  testFailureMessage: string | null;
  typeLabel: string;
}

/** Everything the wizard chrome says about the current provider and the last test run. */
export const resolveIdentityProviderWizardMessages = ({
  attempt,
  busy,
  captureAttemptId,
  draft,
  fixedProtocol,
  provider,
  t,
  testPolling,
  testResultData,
  testResultError,
  testWaitMessage,
}: IdentityProviderWizardMessagesInput): IdentityProviderWizardMessages => {
  // The DingTalk provider key becomes the sub-domain of the synthesized login email
  // (`<unionId>@<providerKey>.dingtalk.sso`), so it must be a DNS label — `_` or a leading /
  // trailing `-` would produce an address the runtime rejects at claim validation.
  const providerKeyError =
    fixedProtocol && draft.providerKey.trim() && !isValidDingTalkProviderKey(draft.providerKey)
      ? t('identityProviders.dingtalk.providerKeyInvalid')
      : null;

  /**
   * Admin-facing explanation of a terminal safe-login / capture failure: our own instruction
   * plus the identity provider's stable error code when it reported one.
   */
  const testFailureMessage =
    testResultData?.status === 'failed'
      ? buildIdentityProviderTestFailureMessage(
          { errorCode: testResultData.errorCode, type: provider?.type ?? draft.type },
          (key, options) => String(t(key as never, options as never)),
        )
      : testResultError
        ? t('identityProviders.test.resultLoadError')
        : testWaitMessage;

  /** True while THIS wizard's organisation capture is still waiting on DingTalk. */
  const capturePending =
    busy === 'capture' || (testPolling && attempt != null && attempt.id === captureAttemptId);

  const resolvedType = provider?.type ?? draft.type;

  return {
    captureFailureMessage:
      attempt != null && attempt.id === captureAttemptId ? testFailureMessage : null,
    capturePending,
    providerKeyError,
    testFailureMessage,
    typeLabel:
      resolvedType === 'authentik'
        ? 'Authentik'
        : resolvedType === 'dingtalk'
          ? t('identityProviders.templates.dingtalk.label')
          : t('identityProviders.templates.genericOidc.label'),
  };
};
