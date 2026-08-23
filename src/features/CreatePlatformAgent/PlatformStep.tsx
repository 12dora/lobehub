'use client';

import type { RemoteHeterogeneousAgentType } from '@lobechat/heterogeneous-agents';
import { Flexbox, Icon } from '@lobehub/ui';
import { Tag } from 'antd';
import { MonitorSmartphone } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { styles } from './style';
import { buildPlatformDefs } from './utils';

interface PlatformStepProps {
  onSelect: (type: RemoteHeterogeneousAgentType) => void;
  platform: RemoteHeterogeneousAgentType;
}

const PlatformStep = memo<PlatformStepProps>(({ onSelect, platform }) => {
  const { t } = useTranslation('chat');

  return (
    <Flexbox gap={12}>
      {buildPlatformDefs(t).map((def) => (
        <div
          className={styles.platformCard}
          data-disabled={def.comingSoon}
          data-selected={!def.comingSoon && platform === def.type}
          key={def.type}
          role="button"
          tabIndex={def.comingSoon ? -1 : 0}
          onClick={() => !def.comingSoon && onSelect(def.type)}
          onKeyDown={(e) => {
            if (!def.comingSoon && (e.key === 'Enter' || e.key === ' ')) onSelect(def.type);
          }}
        >
          <Flexbox horizontal align="center" gap={8}>
            <Icon icon={MonitorSmartphone} size={18} />
            <span className={styles.platformName}>{def.name}</span>
            {def.comingSoon && (
              <Tag style={{ marginInlineEnd: 0 }}>{t('platformAgent.create.comingSoon')}</Tag>
            )}
          </Flexbox>
          <span className={styles.platformDesc}>{def.desc}</span>
        </div>
      ))}
    </Flexbox>
  );
});

PlatformStep.displayName = 'PlatformStep';

export default PlatformStep;
