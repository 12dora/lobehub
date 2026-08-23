'use client';

import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { TopicEvidence } from './useTopicEvidence';

export interface TopicMessagePagerProps {
  pager: TopicEvidence['pager'];
}

/** Cursor pager for the message evidence pages. */
const TopicMessagePager = memo<TopicMessagePagerProps>(({ pager }) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox horizontal gap={8} style={{ marginBlockStart: 12 }}>
      <Button disabled={!pager.hasPrevious} size="small" onClick={pager.onPrevious}>
        {t('primitives.dataTable.previous')}
      </Button>
      <Button disabled={!pager.hasNext} size="small" onClick={pager.onNext}>
        {t('primitives.dataTable.next')}
      </Button>
    </Flexbox>
  );
});

TopicMessagePager.displayName = 'AuditTopicMessagePager';

export default TopicMessagePager;
