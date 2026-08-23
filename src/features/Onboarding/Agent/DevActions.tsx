'use client';

import { Button } from '@lobehub/ui';
import { History } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import ModeSwitch from '@/features/Onboarding/components/ModeSwitch';
import { isDev } from '@/utils/env';

import AgentOnboardingDebugExportButton from './DebugExportButton';

interface DevActionsProps {
  agentId: string;
  hasHistory: boolean;
  isResetting: boolean;
  onOpenHistory: () => void;
  onReset: () => void;
  topicId?: string;
}

/** Dev-only footer: flow switcher plus the debug export / history / reset controls. */
const DevActions = memo<DevActionsProps>(
  ({ agentId, hasHistory, isResetting, onOpenHistory, onReset, topicId }) => {
    const { t } = useTranslation('onboarding');

    if (!isDev) return null;

    return (
      <ModeSwitch
        actions={
          <>
            <AgentOnboardingDebugExportButton agentId={agentId} topicId={topicId} />
            {hasHistory && (
              <Button icon={<History size={14} />} size={'small'} onClick={onOpenHistory}>
                {t('agent.history.title')}
              </Button>
            )}
            <Button danger loading={isResetting} size={'small'} onClick={onReset}>
              {t('agent.modeSwitch.reset')}
            </Button>
          </>
        }
      />
    );
  },
);

DevActions.displayName = 'DevActions';

export default DevActions;
