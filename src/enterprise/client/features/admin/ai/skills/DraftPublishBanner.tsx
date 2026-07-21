'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import {
  adminSkillsService,
  clearLastAdminSkillPublishOutcome,
  getLastAdminSkillPublishOutcome,
} from '@/enterprise/client/services/adminSkills';

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
  activeSkillId?: string | null;
  onPublished?: () => void;
}

/**
 * Shows when the last admin skill write left a draft unpublished (first-publish gate or soft fail).
 */
const DraftPublishBanner = memo<DraftPublishBannerProps>(({ activeSkillId, onPublished }) => {
  const { t } = useTranslation('admin');
  const [retrying, setRetrying] = useState(false);
  const [, setTick] = useState(0);
  const outcome = getLastAdminSkillPublishOutcome();
  const show =
    Boolean(outcome && !outcome.published) &&
    (!activeSkillId || outcome!.skillId === activeSkillId);

  const onRetry = useCallback(async () => {
    if (!outcome?.skillId) return;
    setRetrying(true);
    try {
      await adminSkillsService.publishNow({
        id: outcome.skillId,
        reason: 'Retry publish from admin skills banner',
      });
      onPublished?.();
      setTick((n) => n + 1);
    } finally {
      setRetrying(false);
    }
  }, [onPublished, outcome?.skillId]);

  const onDismiss = useCallback(() => {
    clearLastAdminSkillPublishOutcome();
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
              t('aiSkillSettings.draftBanner.desc', {
                defaultValue:
                  'Publish requires a valid skill version. Add a version or fix validation, then retry.',
              })}
          </Text>
          <div className={styles.actions}>
            <Button loading={retrying} size="small" onClick={onRetry}>
              {t('aiSkillSettings.draftBanner.retry', { defaultValue: 'Retry publish' })}
            </Button>
            <Link className={styles.link} to="/admin/skills">
              {t('aiSkillSettings.advancedCatalog', {
                defaultValue: 'Advanced catalog management',
              })}
            </Link>
          </div>
        </Flexbox>
      }
      message={t('aiSkillSettings.draftBanner.title', {
        defaultValue: 'Changes saved as draft — not live yet',
      })}
      onClose={onDismiss}
    />
  );
});

DraftPublishBanner.displayName = 'AdminSkillDraftPublishBanner';

export default DraftPublishBanner;
