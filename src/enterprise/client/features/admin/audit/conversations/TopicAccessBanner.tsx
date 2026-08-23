'use client';

import { Flexbox } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AuditContentAccessMode } from '../shared/liveMessageUtils';
import { styles } from './topicPageStyles';

export interface TopicAccessBannerProps {
  contentAccessMode: AuditContentAccessMode | undefined;
  includeBody: boolean;
  onToggleBody: (checked: boolean) => void;
}

/**
 * States what this policy lets the auditor see: metadata only, or content behind an explicit
 * reveal toggle. Renders nothing for any other mode — `disabled` never reaches this page.
 */
const TopicAccessBanner = memo<TopicAccessBannerProps>(
  ({ contentAccessMode, includeBody, onToggleBody }) => {
    const { t } = useTranslation('admin');

    if (contentAccessMode === 'metadata_only') {
      return (
        <div className={styles.banner} role="status">
          {t('audit.conversations.topic.metadataOnlyBanner')}
        </div>
      );
    }

    if (contentAccessMode === 'content_allowed') {
      return (
        <div className={styles.banner} role="status">
          <Flexbox horizontal align="center" gap={12}>
            <span>{t('audit.conversations.topic.bodyToggleLabel')}</span>
            <Switch checked={includeBody} onChange={(checked) => onToggleBody(Boolean(checked))} />
          </Flexbox>
        </div>
      );
    }

    return null;
  },
);

TopicAccessBanner.displayName = 'AuditTopicAccessBanner';

export default TopicAccessBanner;
