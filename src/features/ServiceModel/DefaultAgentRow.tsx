'use client';

import type { EffortLevel } from '@lobechat/model-runtime';
import type { LobeAgentChatConfig } from '@lobechat/types';
import { Flexbox, Tooltip } from '@lobehub/ui';
import { memo } from 'react';

import ModelSelect from '@/features/ModelSelect';
import { ManagedCompositeSettingFieldContent } from '@/features/PlatformSettingSourceBadge/ManagedSettingField';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { LobeAgentSettings } from '@/types/session';

import { MODEL_SELECT_STYLE, ROW_STYLE } from './const';
import EffortSelect from './EffortSelect';
import type { ActiveEffortControl } from './useModelAssignmentsForm';

interface DefaultAgentRowProps {
  activeEffortMetas: PlatformSettingMetaState[];
  canManage: boolean;
  defaultAgent: LobeAgentSettings;
  disabledReason?: string;
  effortClearable: boolean;
  effortControl: ActiveEffortControl;
  metas: readonly PlatformSettingMetaState[];
  onUpdateEffort: (
    level: EffortLevel | undefined,
    configKey: keyof LobeAgentChatConfig,
  ) => Promise<void>;
  onUpdateModel: (value: { model: string; provider: string }) => Promise<void>;
  /** The surface omits the effort writer when it cannot persist one (tests / plain forms). */
  showEffortPicker: boolean;
}

const DefaultAgentRow = memo<DefaultAgentRowProps>(
  ({
    activeEffortMetas,
    canManage,
    defaultAgent,
    disabledReason,
    effortClearable,
    effortControl,
    metas,
    onUpdateEffort,
    onUpdateModel,
    showEffortPicker,
  }) => (
    <ManagedCompositeSettingFieldContent metas={metas}>
      {({ disabled }) => (
        <Tooltip title={disabledReason}>
          <Flexbox align="center" direction="horizontal" gap={12} style={ROW_STYLE}>
            <ModelSelect
              disabled={disabled || !canManage}
              showAbility={false}
              style={MODEL_SELECT_STYLE}
              value={defaultAgent.config}
              onChange={onUpdateModel}
            />
            {showEffortPicker && (
              <ManagedCompositeSettingFieldContent metas={activeEffortMetas}>
                {({ disabled: effortDisabled }) => {
                  const stored = effortControl
                    ? (defaultAgent.config.chatConfig?.[effortControl.definition.configKey] as
                        string | undefined)
                    : undefined;
                  return (
                    <EffortSelect
                      chatConfig={effortClearable ? undefined : defaultAgent.config.chatConfig}
                      disabled={effortDisabled || !canManage}
                      model={defaultAgent.config.model}
                      provider={defaultAgent.config.provider ?? ''}
                      value={effortClearable ? (stored ?? null) : undefined}
                      onChange={onUpdateEffort}
                    />
                  );
                }}
              </ManagedCompositeSettingFieldContent>
            )}
          </Flexbox>
        </Tooltip>
      )}
    </ManagedCompositeSettingFieldContent>
  ),
);

DefaultAgentRow.displayName = 'DefaultAgentRow';

export default DefaultAgentRow;
