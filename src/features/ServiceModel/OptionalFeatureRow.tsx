'use client';

import { Flexbox, Tooltip } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';

import ModelSelect from '@/features/ModelSelect';
import { ManagedCompositeSettingFieldContent } from '@/features/PlatformSettingSourceBadge/ManagedSettingField';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { SystemAgentItem } from '@/types/user/settings';

import { MODEL_SELECT_STYLE, ROW_STYLE } from './const';
import EffortSelect from './EffortSelect';

interface OptionalFeatureRowProps {
  ariaLabel: string;
  canManage: boolean;
  disabledReason?: string;
  enabledMetas: PlatformSettingMetaState[];
  loading: boolean;
  metas: readonly PlatformSettingMetaState[];
  onUpdate: (value: Partial<SystemAgentItem>) => Promise<void>;
  value: SystemAgentItem;
}

const OptionalFeatureRow = memo<OptionalFeatureRowProps>(
  ({ ariaLabel, canManage, disabledReason, enabledMetas, loading, metas, onUpdate, value }) => (
    <Tooltip title={disabledReason}>
      <Flexbox align="center" direction="horizontal" gap={12} style={ROW_STYLE}>
        <ManagedCompositeSettingFieldContent metas={metas}>
          {({ disabled }) => (
            <Flexbox align="center" direction="horizontal" gap={12}>
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
          )}
        </ManagedCompositeSettingFieldContent>
        <ManagedCompositeSettingFieldContent metas={enabledMetas}>
          {({ disabled }) => (
            <Flexbox align="center" direction="horizontal" gap={8}>
              <Switch
                aria-label={ariaLabel}
                checked={value.enabled}
                disabled={disabled || !canManage}
                loading={loading}
                onChange={(enabled) => onUpdate({ enabled })}
              />
            </Flexbox>
          )}
        </ManagedCompositeSettingFieldContent>
      </Flexbox>
    </Tooltip>
  ),
);

OptionalFeatureRow.displayName = 'OptionalFeatureRow';

export default OptionalFeatureRow;
