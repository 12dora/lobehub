'use client';

import { Alert, Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import RevisionBanner from '../primitives/RevisionBanner';
import type { AdminConnectorGetOutput } from './types';

interface ConnectorDetailBannerProps {
  actionError: string | null;
  conflict: boolean;
  onDiscardConflict: () => void;
  onRefreshConflict: () => void;
  readOnly: boolean;
  /** Localized notice after crash recovery of secret intent (clear / reentry). */
  restoreNotice?: string | null;
  snapshot: AdminConnectorGetOutput;
}

const ConnectorDetailBanner = memo<ConnectorDetailBannerProps>(
  ({
    actionError,
    conflict,
    onDiscardConflict,
    onRefreshConflict,
    readOnly,
    restoreNotice,
    snapshot,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <>
        <RevisionBanner
          conflict={conflict}
          draftRevision={snapshot.baseRevision}
          publishedRevision={snapshot.published?.publishedRevision ?? null}
          status={snapshot.draft.status}
        />
        {readOnly ? (
          <Alert showIcon message={t('connectorCatalog.readOnly')} type={'info'} />
        ) : null}
        {restoreNotice ? <Alert showIcon message={restoreNotice} type={'warning'} /> : null}
        {conflict ? (
          <Alert
            showIcon
            description={t('connectorCatalog.conflict.description')}
            message={t('connectorCatalog.conflict.title')}
            type={'warning'}
            extra={
              <Flexbox horizontal gap={8}>
                <Button onClick={onRefreshConflict}>
                  {t('connectorCatalog.conflict.refresh')}
                </Button>
                <Button onClick={onDiscardConflict}>
                  {t('connectorCatalog.conflict.discard')}
                </Button>
              </Flexbox>
            }
          />
        ) : null}
        {actionError ? <Alert showIcon message={actionError} type={'error'} /> : null}
      </>
    );
  },
);

ConnectorDetailBanner.displayName = 'AdminConnectorDetailBanner';

export default ConnectorDetailBanner;
