'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { adminIdentityProvidersService } from '@/enterprise/client/services/adminIdentityProviders';

type RevisionItem = Awaited<
  ReturnType<typeof adminIdentityProvidersService.listPublishedRevisions>
>[number];

interface PublishStepProps {
  activationRevision: number | null | undefined;
  busy: string | null;
  canPublish: boolean;
  dirty: boolean;
  hasProvider: boolean;
  historyError: boolean;
  onPublish: (rollback: boolean) => void;
  onRetryHistory: () => void;
  onRollbackTargetChange: (value: number | undefined) => void;
  revisions: RevisionItem[] | undefined;
  rollbackTarget: number | undefined;
}

export const PublishStep = memo<PublishStepProps>(
  ({
    activationRevision,
    busy,
    canPublish,
    dirty,
    hasProvider,
    historyError,
    onPublish,
    onRetryHistory,
    onRollbackTargetChange,
    revisions,
    rollbackTarget,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox gap={12}>
        <Text>{t('identityProviders.publish.description')}</Text>
        <Flexbox horizontal gap={8}>
          <Button
            disabled={!hasProvider || dirty || !canPublish}
            loading={busy === 'publish'}
            type="primary"
            onClick={() => onPublish(false)}
          >
            {t('identityProviders.actions.publish')}
          </Button>
          <Select
            aria-label={t('identityProviders.rollback.target')}
            placeholder={t('identityProviders.rollback.target')}
            style={{ minWidth: 220 }}
            value={rollbackTarget}
            options={(revisions ?? [])
              .filter((item) => item.revision !== activationRevision)
              .map((item) => ({
                label: t('identityProviders.rollback.revisionOption', {
                  publishedAt: item.publishedAt.toLocaleString(),
                  revision: item.revision,
                }),
                value: item.revision,
              }))}
            onChange={(value) => onRollbackTargetChange(value as number | undefined)}
          />
          <Button
            danger
            disabled={!activationRevision || !rollbackTarget || dirty || !canPublish}
            loading={busy === 'rollback'}
            onClick={() => onPublish(true)}
          >
            {t('identityProviders.actions.rollback')}
          </Button>
        </Flexbox>
        {historyError ? (
          <Alert
            showIcon
            description={t('identityProviders.rollback.historyLoadError')}
            type="error"
            action={
              <Button size="small" onClick={onRetryHistory}>
                {t('identityProviders.actions.retry')}
              </Button>
            }
          />
        ) : null}
      </Flexbox>
    );
  },
);

PublishStep.displayName = 'PublishStep';
