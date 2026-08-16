'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { formatAdminDateTime } from '../../../users/utils';
import ManageGuard from '../../ManageGuard';
import { moderationStyles as styles } from '../../styles';
import type { ModerationRecordDetail } from '../../types';
import { Section } from './primitives';

export interface ContentSectionProps {
  canManage: boolean;
  fullPrompt: string | null;
  onReveal: () => void;
  record: ModerationRecordDetail;
  revealing: boolean;
}

const ContentSection = memo<ContentSectionProps>(
  ({ canManage, fullPrompt, onReveal, record, revealing }) => {
    const { t } = useTranslation('admin');

    return (
      <Section title={t('contentModeration.records.sectionContent')}>
        <Text type="secondary">{t('contentModeration.records.excerptHint')}</Text>
        <pre className={styles.excerpt}>{record.promptExcerpt || '—'}</pre>
        {record.hasFullPrompt ? (
          fullPrompt === null ? (
            <Flexbox gap={8}>
              <Text type="secondary">{t('contentModeration.records.revealHint')}</Text>
              <div>
                <ManageGuard allowed={canManage}>
                  <Button disabled={!canManage} loading={revealing} size="small" onClick={onReveal}>
                    {t('contentModeration.records.reveal')}
                  </Button>
                </ManageGuard>
              </div>
            </Flexbox>
          ) : (
            <pre className={styles.excerpt}>{fullPrompt}</pre>
          )
        ) : null}
        {record.revealedAt ? (
          <Text className={styles.hintText}>
            {t('contentModeration.records.revealedAt', {
              time: formatAdminDateTime(record.revealedAt),
              user: record.revealedBy ?? '—',
            })}
          </Text>
        ) : null}
      </Section>
    );
  },
);

ContentSection.displayName = 'ModerationRecordContentSection';

export default ContentSection;
