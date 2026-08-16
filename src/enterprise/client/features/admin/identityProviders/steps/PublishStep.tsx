'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

type TestResult = Awaited<ReturnType<typeof adminIdentityProvidersService.testResult>>;

interface PublishStepProps {
  attempt: { id: string; startedAt: number } | null;
  /** Kind-specific precondition that must be resolved before publishing. */
  blocker?: string;
  busy: string | null;
  canPublish: boolean;
  canTest: boolean;
  dirty: boolean;
  draftWorkflowReady: boolean;
  /** Admin-facing explanation of a failed attempt (mapped from the server error code). */
  failureMessage?: string | null;
  hasProvider: boolean;
  onRetryResult: () => void;
  onStartTest: () => void;
  resultError: boolean;
  testResult: TestResult | undefined;
  testSucceeded: boolean;
}

/**
 * Final wizard step. Hosts the safe login test (the publish hard-precondition) and
 * the publish guidance; the publish action itself rides the footer's primary button.
 * Rollback / revision selection was intentionally removed — the login method keeps a
 * single mutable draft head.
 */
export const PublishStep = memo<PublishStepProps>(
  ({
    attempt,
    blocker,
    busy,
    canPublish,
    canTest,
    dirty,
    draftWorkflowReady,
    failureMessage,
    hasProvider,
    onRetryResult,
    onStartTest,
    resultError,
    testResult,
    testSucceeded,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox gap={20}>
        <Flexbox gap={8}>
          <Text strong>{t('identityProviders.test.title')}</Text>
          <Text type="secondary">{t('identityProviders.test.description')}</Text>
          {hasProvider && !draftWorkflowReady ? (
            <Alert
              showIcon
              description={t('identityProviders.workflow.draftRequired')}
              type="warning"
            />
          ) : null}
          <Flexbox horizontal>
            <Button
              disabled={!hasProvider || !draftWorkflowReady || dirty || !canTest}
              loading={busy === 'test'}
              onClick={onStartTest}
            >
              {t('identityProviders.actions.startTest')}
            </Button>
          </Flexbox>
          {attempt && Date.now() - attempt.startedAt > 120_000 ? (
            <Alert showIcon description={t('identityProviders.test.timeout')} type="warning" />
          ) : null}
          {testResult ? (
            <Alert
              showIcon
              description={t('identityProviders.test.status', {
                status: t(`identityProviders.values.testStatus.${testResult.status}` as never),
              })}
              type={
                testResult.status === 'succeeded' && testResult.result?.valid
                  ? 'success'
                  : testResult.status === 'failed'
                    ? 'error'
                    : 'info'
              }
            />
          ) : null}
          {testResult?.status === 'failed' && failureMessage ? (
            <Alert showIcon description={failureMessage} type="error" />
          ) : null}
          {testResult?.result ? (
            <Flexbox horizontal gap={6} wrap="wrap">
              {Object.entries(testResult.result.claims).map(([claim, summary]) => (
                <Tag key={claim}>
                  {t('identityProviders.test.claimPresent', {
                    claim,
                    type: t(`identityProviders.values.claimType.${summary.type}` as never),
                  })}
                </Tag>
              ))}
            </Flexbox>
          ) : null}
          {resultError ? (
            <Alert
              showIcon
              description={t('identityProviders.test.resultLoadError')}
              type="error"
              action={
                <Button size="small" onClick={onRetryResult}>
                  {t('identityProviders.actions.retry')}
                </Button>
              }
            />
          ) : null}
        </Flexbox>
        <Flexbox gap={8}>
          <Text strong>{t('identityProviders.publish.title')}</Text>
          <Text type="secondary">{t('identityProviders.publish.description')}</Text>
          {blocker ? <Alert showIcon description={blocker} type="warning" /> : null}
          {hasProvider && draftWorkflowReady && canPublish && !testSucceeded ? (
            <Alert
              showIcon
              description={t('identityProviders.workflow.testRequired')}
              type="info"
            />
          ) : null}
        </Flexbox>
      </Flexbox>
    );
  },
);

PublishStep.displayName = 'PublishStep';
