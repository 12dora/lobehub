'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

type TestResult = Awaited<ReturnType<typeof adminIdentityProvidersService.testResult>>;

interface TestStepProps {
  attempt: { id: string; startedAt: number } | null;
  busy: string | null;
  canTest: boolean;
  dirty: boolean;
  hasProvider: boolean;
  onRetryResult: () => void;
  onStartTest: () => void;
  resultError: boolean;
  testResult: TestResult | undefined;
}

export const TestStep = memo<TestStepProps>(
  ({
    attempt,
    busy,
    canTest,
    dirty,
    hasProvider,
    onRetryResult,
    onStartTest,
    resultError,
    testResult,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox gap={12}>
        <Text>{t('identityProviders.test.description')}</Text>
        <Button
          disabled={!hasProvider || dirty || !canTest}
          loading={busy === 'test'}
          onClick={onStartTest}
        >
          {t('identityProviders.actions.startTest')}
        </Button>
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
    );
  },
);

TestStep.displayName = 'TestStep';
