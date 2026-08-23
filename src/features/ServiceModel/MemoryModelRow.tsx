'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import ModelSelect from '@/features/ModelSelect';
import { ManagedCompositeSettingFieldContent } from '@/features/PlatformSettingSourceBadge/ManagedSettingField';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { SystemAgentItem } from '@/types/user/settings';

import { MODEL_SELECT_STYLE } from './const';
import ContextLimitInput from './ContextLimitInput';
import EffortSelect from './EffortSelect';

interface MemoryModelRowProps {
  canManage: boolean;
  contextLimitMetas: PlatformSettingMetaState[];
  contextLimitPlaceholder: string;
  metas: readonly PlatformSettingMetaState[];
  modelType?: 'chat' | 'embedding';
  onUpdate: (value: Partial<SystemAgentItem>) => Promise<void>;
  showContextLimit: boolean;
  value: SystemAgentItem;
}

const MemoryModelRow = memo<MemoryModelRowProps>(
  ({
    canManage,
    contextLimitMetas,
    contextLimitPlaceholder,
    metas,
    modelType,
    onUpdate,
    showContextLimit,
    value,
  }) => (
    <Flexbox direction="vertical" gap={8} style={{ width: 448 }}>
      <ManagedCompositeSettingFieldContent metas={metas}>
        {({ disabled }) => (
          <Flexbox align="center" direction="horizontal" gap={12}>
            <ModelSelect
              disabled={disabled || !canManage}
              modelType={modelType}
              showAbility={false}
              style={MODEL_SELECT_STYLE}
              value={value}
              onChange={onUpdate}
            />
            {/* Embedding models have no thinking budget — only the two chat
             * memory agents (analysis / persona writer) get an effort picker. */}
            {modelType !== 'embedding' && (
              <EffortSelect
                disabled={disabled || !canManage}
                model={value.model}
                provider={value.provider}
                value={value.reasoningEffort}
                onChange={(level) => onUpdate({ reasoningEffort: level ?? null })}
              />
            )}
          </Flexbox>
        )}
      </ManagedCompositeSettingFieldContent>
      {showContextLimit && (
        <ManagedCompositeSettingFieldContent metas={contextLimitMetas}>
          {({ disabled }) => (
            <ContextLimitInput
              canManage={canManage && !disabled}
              placeholder={contextLimitPlaceholder}
              value={value.contextLimit}
              onCommit={(nextLimit) => onUpdate({ contextLimit: nextLimit })}
            />
          )}
        </ManagedCompositeSettingFieldContent>
      )}
    </Flexbox>
  ),
);

MemoryModelRow.displayName = 'MemoryModelRow';

export default MemoryModelRow;
