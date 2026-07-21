'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import {
  adminAiProviderService,
  clearLastAdminPublishOutcome,
  getLastAdminPublishOutcome,
} from '@/enterprise/client/services/adminAiInfraAdapter';
import { useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

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

/**
 * Shows when the last admin write left a draft unpublished (first-publish gate or soft fail).
 */
const DraftPublishBanner = memo(() => {
  const { t } = useTranslation('admin');
  const activeId = useAiInfraStore((s) => s.activeAiProvider);
  const refreshList = useAiInfraStore((s) => s.refreshAiProviderList);
  const refreshDetail = useAiInfraStore((s) => s.refreshAiProviderDetail);
  const [retrying, setRetrying] = useState(false);
  // Re-read outcome when active provider changes or after retry (force tick via state).
  const [, setTick] = useState(0);
  const outcome = getLastAdminPublishOutcome();
  const show =
    outcome &&
    !outcome.published &&
    (!activeId || outcome.providerId === activeId || outcome.providerId === activeId);

  const onRetry = useCallback(async () => {
    if (!outcome?.providerId) return;
    setRetrying(true);
    try {
      await adminAiProviderService.publishNow(outcome.providerId);
      await refreshList();
      await refreshDetail();
      setTick((n) => n + 1);
    } finally {
      setRetrying(false);
    }
  }, [outcome?.providerId, refreshDetail, refreshList]);

  const onDismiss = useCallback(() => {
    clearLastAdminPublishOutcome();
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
              t('aiProviderSettings.draftBanner.desc', {
                defaultValue:
                  'Publish requires credentials, at least one enabled model, and a successful connection test.',
              })}
          </Text>
          <div className={styles.actions}>
            <Button loading={retrying} size="small" onClick={onRetry}>
              {t('aiProviderSettings.draftBanner.retry', { defaultValue: 'Retry publish' })}
            </Button>
            <Link className={styles.link} to="/admin/ai/catalog/providers">
              {t('aiProviderSettings.advancedCatalog', {
                defaultValue: 'Advanced catalog management',
              })}
            </Link>
          </div>
        </Flexbox>
      }
      message={t('aiProviderSettings.draftBanner.title', {
        defaultValue: 'Changes saved as draft — not live yet',
      })}
      onClose={onDismiss}
    />
  );
});

DraftPublishBanner.displayName = 'DraftPublishBanner';

export default DraftPublishBanner;
