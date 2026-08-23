'use client';

import { Flexbox, Tooltip } from '@lobehub/ui';
import { memo } from 'react';

import ModelSelect from '@/features/ModelSelect';
import { ManagedCompositeSettingFieldContent } from '@/features/PlatformSettingSourceBadge/ManagedSettingField';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { SystemAgentItem } from '@/types/user/settings';

import { MODEL_SELECT_STYLE, ROW_STYLE } from './const';
import EffortSelect from './EffortSelect';

interface SystemAgentModelRowProps {
  canManage: boolean;
  disabledReason?: string;
  metas: readonly PlatformSettingMetaState[];
  onUpdate: (value: Partial<SystemAgentItem>) => Promise<void>;
  value: SystemAgentItem;
}

const SystemAgentModelRow = memo<SystemAgentModelRowProps>(
  ({ canManage, disabledReason, metas, onUpdate, value }) => (
    // An empty meta list renders the children unmanaged, so one branch covers both
    // the policy-enabled user page and the admin platform-defaults page.
    <ManagedCompositeSettingFieldContent metas={metas}>
      {({ disabled }) => (
        <Tooltip title={disabledReason}>
          <Flexbox align="center" direction="horizontal" gap={12} style={ROW_STYLE}>
            <ModelSelect
              disabled={disabled || !canManage}
              showAbility={false}
              style={MODEL_SELECT_STYLE}
              value={value}
              onChange={onUpdate}
            />
            <EffortSelect
              disabled={disabled || !canManage}
              model={value.model}
              provider={value.provider}
              value={value.reasoningEffort}
              onChange={(level) => onUpdate({ reasoningEffort: level ?? null })}
            />
          </Flexbox>
        </Tooltip>
      )}
    </ManagedCompositeSettingFieldContent>
  ),
);

SystemAgentModelRow.displayName = 'SystemAgentModelRow';

export default SystemAgentModelRow;
