'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import {
  adminConnectorsService,
  clearLastAdminConnectorPublishOutcome,
  getLastAdminConnectorPublishOutcome,
} from '@/enterprise/client/services/adminConnectors';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  link: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
}));

interface DraftPublishBannerProps {
  activeConnectorId?: string | null;
  onPublished?: () => void;
}

/**
 * Shows when the last admin connector write left a draft unpublished.
 */
const DraftPublishBanner = memo<DraftPublishBannerProps>(({ activeConnectorId, onPublished }) => {
  const { t } = useTranslation('admin');
  const [retrying, setRetrying] = useState(false);
  const [, setTick] = useState(0);
  const outcome = getLastAdminConnectorPublishOutcome();
  const show =
    Boolean(outcome && !outcome.published) &&
    (!activeConnectorId || outcome!.connectorId === activeConnectorId);

  const onRetry = useCallback(async () => {
    if (!outcome?.connectorId) return;
    setRetrying(true);
    try {
      await adminConnectorsService.publishNow({
        id: outcome.connectorId,
        reason: 'Retry publish from admin connectors banner',
      });
      onPublished?.();
      setTick((n) => n + 1);
    } finally {
      setRetrying(false);
    }
  }, [onPublished, outcome?.connectorId]);

  const onDismiss = useCallback(() => {
    clearLastAdminConnectorPublishOutcome();
    setTick((n) => n + 1);
  }, []);

  if (!show || !outcome) return null;

  return (
    <Alert
      closable
      showIcon
      type="warning"
      description={
        <Flexbox gap={8}>
          <Text type="secondary">
            {outcome.publishError ||
              t('aiConnectorSettings.draftBanner.desc', {
                defaultValue:
                  'Publish requires an enabled connector with at least one enabled tool and a valid endpoint.',
              })}
          </Text>
          <div className={styles.actions}>
            <Button loading={retrying} size="small" onClick={onRetry}>
              {t('aiConnectorSettings.draftBanner.retry', { defaultValue: 'Retry publish' })}
            </Button>
            <Link className={styles.link} to="/admin/connectors">
              {t('aiConnectorSettings.advancedCatalog', {
                defaultValue: 'Advanced catalog management',
              })}
            </Link>
          </div>
        </Flexbox>
      }
      message={t('aiConnectorSettings.draftBanner.title', {
        defaultValue: 'Changes saved as draft — not live yet',
      })}
      onClose={onDismiss}
    />
  );
});

DraftPublishBanner.displayName = 'AdminConnectorDraftPublishBanner';

export default DraftPublishBanner;
