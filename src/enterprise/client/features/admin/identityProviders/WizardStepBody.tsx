'use client';

import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import type { TFunction } from 'i18next';
import type { Dispatch, SetStateAction } from 'react';
import { memo } from 'react';

import type { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

import type { IdentityProviderCallbackUrls } from './controller';
import type { IdentityProviderStep } from './IdentityProviderWizardNavigation';
import {
  BasicStep,
  ClaimsStep,
  ClientStep,
  DiscoveryStep,
  type EditableDraft,
  type PatchDraft,
  PolicyStep,
  PublishStep,
} from './steps';

type DiscoveryMetadata = Awaited<ReturnType<typeof adminIdentityProvidersService.discover>>;
type TestResult = Awaited<ReturnType<typeof adminIdentityProvidersService.testResult>>;

interface WizardStepBodyProps {
  attempt: { id: string; revision: number; startedAt: number } | null;
  busy: string | null;
  callbacks?: IdentityProviderCallbackUrls;
  canPublish: boolean;
  canTest: boolean;
  captureBlockedReason: string | null;
  captureFailureMessage: string | null;
  capturePending: boolean;
  claimJson: string;
  clearSecret: boolean;
  copyUrl: (url: string) => void;
  corpAllowlistMissing: boolean;
  dirty: boolean;
  discover: () => void;
  discovery: DiscoveryMetadata | null;
  draft: EditableDraft;
  draftWorkflowReady: boolean;
  handleClaimJsonChange: (raw: string) => void;
  jsonErrors: { claims: boolean };
  networkValid: boolean;
  patch: PatchDraft;
  provider?: PlatformIdentityProviderDraft;
  providerKeyError: string | null;
  secret: string;
  setClearSecret: Dispatch<SetStateAction<boolean>>;
  setDiscovery: Dispatch<SetStateAction<DiscoveryMetadata | null>>;
  setNetworkValid: Dispatch<SetStateAction<boolean>>;
  setSecret: Dispatch<SetStateAction<string>>;
  startTest: (intent?: 'capture' | 'test') => void;
  step: IdentityProviderStep;
  t: TFunction<'admin'>;
  testFailureMessage: string | null;
  testResult: {
    data?: TestResult;
    error?: unknown;
    mutate: () => unknown;
  };
  testSucceeded: boolean;
}

export const WizardStepBody = memo<WizardStepBodyProps>(
  ({
    attempt,
    busy,
    callbacks,
    canPublish,
    canTest,
    captureBlockedReason,
    captureFailureMessage,
    capturePending,
    claimJson,
    clearSecret,
    copyUrl,
    corpAllowlistMissing,
    dirty,
    discover,
    discovery,
    draft,
    draftWorkflowReady,
    handleClaimJsonChange,
    jsonErrors,
    networkValid,
    patch,
    provider,
    providerKeyError,
    secret,
    setClearSecret,
    setDiscovery,
    setNetworkValid,
    setSecret,
    startTest,
    step,
    t,
    testFailureMessage,
    testResult,
    testSucceeded,
  }) => {
    switch (step) {
      case 'basic': {
        return (
          <BasicStep
            draft={draft}
            patch={patch}
            providerKeyError={providerKeyError}
            providerKeyLocked={Boolean(provider)}
          />
        );
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
        return (
          <PolicyStep
            callbacks={callbacks}
            captureBlockedReason={captureBlockedReason}
            captureError={captureFailureMessage}
            capturing={capturePending}
            draft={draft}
            patch={patch}
            onCaptureCorp={() => startTest('capture')}
            onCopyUrl={copyUrl}
          />
        );
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
            failureMessage={testFailureMessage}
            hasProvider={Boolean(provider)}
            resultError={Boolean(testResult.error)}
            testResult={testResult.data}
            testSucceeded={testSucceeded}
            blocker={
              corpAllowlistMissing
                ? t('identityProviders.dingtalk.allowedCorps.publishBlocked')
                : undefined
            }
            onRetryResult={() => void testResult.mutate()}
            onStartTest={() => startTest('test')}
          />
        );
      }
    }
  },
);

WizardStepBody.displayName = 'WizardStepBody';
