'use client';

import { type UserMemoryEffort } from '@lobechat/types';
import { type FormGroupItemType } from '@lobehub/ui';
import { Form, Skeleton, Tooltip } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AutoSaveHint from '@/components/Editor/AutoSaveHint';
import { FORM_STYLE } from '@/const/layoutTokens';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import LevelSlider from '@/features/ModelSwitchPanel/components/ControlsForm/LevelSlider';
import { ManagedFormControlContent } from '@/features/PlatformSettingSourceBadge/ManagedFormControl';
import { ManagedSettingFieldContent } from '@/features/PlatformSettingSourceBadge/ManagedSettingField';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { useSaveState } from '@/hooks/useSaveState';

const MEMORY_EFFORT_LEVELS: readonly UserMemoryEffort[] = ['low', 'medium', 'high'];

export interface MemoryFormValue {
  effort?: UserMemoryEffort;
  enabled?: boolean;
}

export interface MemoryFormViewProps {
  canManage: boolean;
  disabledReason?: string;
  effortMeta?: PlatformSettingMetaState;
  enabledMeta?: PlatformSettingMetaState;
  isInit: boolean;
  onChange: (patch: MemoryFormValue) => Promise<void> | void;
  saveState: Pick<ReturnType<typeof useSaveState>, 'lastSavedAt' | 'retry' | 'save' | 'status'>;
  value: MemoryFormValue;
}

const WRITABLE_META: PlatformSettingMetaState = {
  canReset: false,
  enabled: true,
  error: undefined,
  hidden: false,
  isLoading: false,
  locked: false,
  meta: undefined,
  mode: 'user',
  reset: async () => false,
  resetError: null,
  resetting: false,
  retry: async () => undefined,
  source: 'user',
  status: 'ready',
};

/**
 * Pure controlled memory settings form (enabled + effort).
 */
const MemoryFormView = memo<MemoryFormViewProps>(
  ({
    canManage,
    disabledReason,
    effortMeta = WRITABLE_META,
    enabledMeta = WRITABLE_META,
    isInit,
    onChange,
    saveState,
    value,
  }) => {
    const { t } = useTranslation('setting');
    const branding = useBranding();
    const [form] = Form.useForm();
    const { status: saveStatus, lastSavedAt, save, retry } = saveState;

    if (!isInit) return <Skeleton active paragraph={{ rows: 3 }} title={false} />;

    const showEnabled = !enabledMeta.hidden;
    const showEffort = !effortMeta.hidden;
    if (!showEnabled && !showEffort) return null;

    const memorySettings: FormGroupItemType = {
      children: [
        ...(showEnabled
          ? [
              {
                children: (
                  <ManagedFormControlContent
                    disabledReason={disabledReason}
                    extraDisabled={!canManage}
                    meta={enabledMeta}
                  >
                    <Switch />
                  </ManagedFormControlContent>
                ),
                desc: t('memory.enabled.desc', { platformName: branding.name }),
                label: t('memory.enabled.title'),
                layout: 'horizontal' as const,
                minWidth: undefined,
                name: 'enabled',
                valuePropName: 'checked',
              },
            ]
          : []),
        ...(showEffort
          ? [
              {
                children: (
                  <Tooltip
                    title={effortMeta.locked ? t('platformSource.managedByOrg') : disabledReason}
                  >
                    <ManagedSettingFieldContent meta={effortMeta}>
                      {({ disabled }) => (
                        <LevelSlider<UserMemoryEffort>
                          defaultValue="medium"
                          disabled={disabled || !canManage}
                          levels={MEMORY_EFFORT_LEVELS}
                          style={{ minWidth: 160 }}
                          value={value?.effort ?? 'medium'}
                          marks={{
                            0: t('memory.effort.level.low'),
                            1: t('memory.effort.level.medium'),
                            2: t('memory.effort.level.high'),
                          }}
                          onChange={(next) => {
                            if (disabled || !canManage) return;
                            save(() => onChange({ effort: next }));
                          }}
                        />
                      )}
                    </ManagedSettingFieldContent>
                  </Tooltip>
                ),
                desc: t('memory.effort.desc'),
                label: t('memory.effort.title'),
                layout: 'horizontal' as const,
                minWidth: undefined,
              },
            ]
          : []),
      ],
      extra: <AutoSaveHint lastUpdatedTime={lastSavedAt} saveStatus={saveStatus} onRetry={retry} />,
      title: t('memory.title'),
    };

    return (
      <Form
        collapsible={false}
        form={form}
        initialValues={value}
        items={[memorySettings]}
        itemsType={'group'}
        variant={'filled'}
        onValuesChange={(values) => {
          if (
            !canManage ||
            enabledMeta.locked ||
            enabledMeta.status === 'loading' ||
            enabledMeta.status === 'error'
          )
            return;

          save(() => onChange(values));
        }}
        {...FORM_STYLE}
      />
    );
  },
);

MemoryFormView.displayName = 'MemoryFormView';

export default MemoryFormView;
