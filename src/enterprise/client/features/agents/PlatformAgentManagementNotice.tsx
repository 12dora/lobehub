import type { PlatformEffectiveAgent } from '@lobechat/types';
import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

import { getPlatformAgentPresentation } from './presentation';

interface PlatformAgentManagementNoticeProps {
  agent: PlatformEffectiveAgent;
  hidden: boolean;
  onHiddenChange?: (hidden: boolean) => void;
}

export const PlatformAgentManagementNotice = ({
  agent,
  hidden,
  onHiddenChange,
}: PlatformAgentManagementNoticeProps) => {
  const { t } = useTranslation('setting');
  const presentation = getPlatformAgentPresentation(agent, hidden);

  return (
    <Alert
      description={t('platformAgents.managed.description')}
      type={presentation.canHide ? 'info' : 'warning'}
      action={
        presentation.canHide && onHiddenChange ? (
          <Button size="small" onClick={() => onHiddenChange(!hidden)}>
            {t(hidden ? 'platformAgents.visibility.show' : 'platformAgents.visibility.hide')}
          </Button>
        ) : null
      }
      message={
        <Flexbox horizontal align="center" gap={8} wrap="wrap">
          <Tag>{t('platformAgents.source.organization')}</Tag>
          <Text>{t(`platformAgents.visibility.${presentation.hideFeedback}` as never)}</Text>
        </Flexbox>
      }
    />
  );
};
