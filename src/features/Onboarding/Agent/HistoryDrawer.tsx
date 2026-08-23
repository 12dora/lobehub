'use client';

import { Drawer } from 'antd';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatTopic } from '@/types/topic';
import { isDev } from '@/utils/env';

import HistoryPanel from './HistoryPanel';

interface HistoryDrawerProps {
  activeTopicId?: string;
  onClose: () => void;
  onSelectTopic: (topicId: string) => void;
  open: boolean;
  selectedTopicId?: string;
  topics: ChatTopic[];
}

/** Dev-only inspector for the onboarding agent's past topics. */
const HistoryDrawer = memo<HistoryDrawerProps>(
  ({ activeTopicId, onClose, onSelectTopic, open, selectedTopicId, topics }) => {
    const { t } = useTranslation('onboarding');

    if (!isDev || topics.length === 0) return null;

    return (
      <Drawer open={open} title={t('agent.history.title')} onClose={onClose}>
        <HistoryPanel
          activeTopicId={activeTopicId}
          selectedTopicId={selectedTopicId}
          topics={topics}
          onSelectTopic={onSelectTopic}
        />
      </Drawer>
    );
  },
);

HistoryDrawer.displayName = 'HistoryDrawer';

export default HistoryDrawer;
