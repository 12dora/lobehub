'use client';

import type { FormGroupItemType, FormItemProps } from '@lobehub/ui';
import { Flexbox, Form, InputNumber, Skeleton, Tooltip } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { ConfigProvider } from 'antd';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import AutoSaveHint from '@/components/Editor/AutoSaveHint';
import { FORM_STYLE } from '@/const/layoutTokens';
import ModelSelect from '@/features/ModelSelect';
import { ManagedCompositeSettingFieldContent } from '@/features/PlatformSettingSourceBadge/ManagedSettingField';
import {
  isPlatformSettingMetaWritable,
  type PlatformSettingMetaState,
} from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { useSaveState } from '@/hooks/useSaveState';
import type { LobeAgentSettings } from '@/types/session';
import type { SystemAgentItem, UserServiceModelConfigKey } from '@/types/user/settings';

export interface SystemAgentModelItem {
  contextLimit?: boolean;
  key: UserServiceModelConfigKey;
  modelType?: 'chat' | 'embedding';
}

type LoadingKey = 'defaultAgent' | UserServiceModelConfigKey;
type SavingGroup = 'assignments' | 'memory' | 'optional';

export const SYSTEM_AGENT_MODEL_ITEMS: SystemAgentModelItem[] = [
  { key: 'topic' },
  { key: 'generationTopic' },
  { key: 'translation' },
  { key: 'historyCompress' },
  { key: 'agentMeta' },
];

export const OPTIONAL_FEATURE_ITEMS: SystemAgentModelItem[] = [
  { key: 'followUpAction' },
  { key: 'inputCompletion' },
  { key: 'promptRewrite' },
];

export const MEMORY_MODEL_ITEMS: SystemAgentModelItem[] = [
  { contextLimit: true, key: 'memoryAnalysisAgentConfig' },
  { contextLimit: true, key: 'userMemoryPersonaWriter' },
  { contextLimit: true, key: 'userMemoryEmbedding', modelType: 'embedding' },
];

export interface ModelAssignmentsFormViewProps {
  canManage: boolean;
  defaultAgent: LobeAgentSettings;
  /** Platform-managed meta for composite fields (optional — omit on admin pages). */
  defaultAgentMetas?: readonly PlatformSettingMetaState[];
  disabledReason?: string;
  initError?: Error | null;
  isInit: boolean;
  onRetryInit?: () => void;
  onUpdateDefaultAgent: (value: { model: string; provider: string }) => Promise<void> | void;
  onUpdateSystemAgent: (
    key: UserServiceModelConfigKey,
    value: Partial<SystemAgentItem>,
  ) => Promise<void> | void;
  saveState: Pick<ReturnType<typeof useSaveState>, 'lastSavedAt' | 'retry' | 'save' | 'status'>;
  systemAgentMetas?: Partial<
    Record<UserServiceModelConfigKey, readonly PlatformSettingMetaState[]>
  >;
  systemAgentSettings: Record<UserServiceModelConfigKey, SystemAgentItem>;
}

/**
 * Pure controlled service-model form. Bind user store or platform defaults externally.
 */
const ModelAssignmentsFormView = memo<ModelAssignmentsFormViewProps>(
  ({
    canManage,
    defaultAgent,
    defaultAgentMetas = [],
    disabledReason,
    initError,
    isInit,
    onRetryInit,
    onUpdateDefaultAgent,
    onUpdateSystemAgent,
    saveState,
    systemAgentMetas = {},
    systemAgentSettings,
  }) => {
    const { t } = useTranslation('setting');
    const [loadingKey, setLoadingKey] = useState<LoadingKey>();
    const [savingGroup, setSavingGroup] = useState<SavingGroup>();
    const { status: saveStatus, lastSavedAt, save, retry } = saveState;

    useEffect(() => {
      if (loadingKey === 'defaultAgent') setLoadingKey(undefined);
    }, [defaultAgent.config.model, defaultAgent.config.provider, loadingKey]);

    const groupOfKey = (key: UserServiceModelConfigKey): SavingGroup => {
      if (MEMORY_MODEL_ITEMS.some((item) => item.key === key)) return 'memory';
      if (OPTIONAL_FEATURE_ITEMS.some((item) => item.key === key)) return 'optional';
      return 'assignments';
    };

    if (!isInit) {
      if (initError)
        return <AsyncError error={initError} variant={'block'} onRetry={() => onRetryInit?.()} />;
      return <Skeleton active paragraph={{ rows: 8 }} title={false} />;
    }

    const updateDefaultAgentModel = async ({
      model,
      provider,
    }: {
      model: string;
      provider: string;
    }) => {
      if (!canManage || defaultAgentMetas.some((meta) => !isPlatformSettingMetaWritable(meta)))
        return;

      setSavingGroup('assignments');
      setLoadingKey('defaultAgent');
      try {
        await save(() => onUpdateDefaultAgent({ model, provider }));
      } finally {
        setLoadingKey(undefined);
      }
    };

    const updateSystemAgentModel = async (
      key: UserServiceModelConfigKey,
      value: Partial<SystemAgentItem>,
    ) => {
      const managedMetas = systemAgentMetas[key] ?? [];
      if (!canManage || managedMetas.some((meta) => !isPlatformSettingMetaWritable(meta))) return;

      setSavingGroup(groupOfKey(key));
      setLoadingKey(key);
      try {
        await save(() => onUpdateSystemAgent(key, value));
      } finally {
        setLoadingKey(undefined);
      }
    };

    const defaultAgentItem: FormItemProps | undefined = defaultAgentMetas.some(
      (meta) => meta.hidden,
    )
      ? undefined
      : {
          children: (
            <ManagedCompositeSettingFieldContent metas={defaultAgentMetas}>
              {({ disabled }) => (
                <Tooltip title={disabledReason}>
                  <Flexbox
                    align="center"
                    direction="horizontal"
                    gap={12}
                    style={{ width: 'min(100%, 448px)' }}
                  >
                    <ModelSelect
                      disabled={disabled || !canManage}
                      showAbility={false}
                      style={{ minWidth: 0, width: '100%' }}
                      value={defaultAgent.config}
                      onChange={updateDefaultAgentModel}
                    />
                  </Flexbox>
                </Tooltip>
              )}
            </ManagedCompositeSettingFieldContent>
          ),
          desc: t('defaultAgent.model.desc'),
          label: t('defaultAgent.title'),
        };

    const systemModelItems: FormItemProps[] = SYSTEM_AGENT_MODEL_ITEMS.map(({ key }) => {
      const value = systemAgentSettings[key];
      const managedMetas = systemAgentMetas[key] ?? [];

      if (managedMetas.some((meta) => meta.hidden)) return null;

      const control = (
        <Tooltip title={disabledReason}>
          <Flexbox
            align="center"
            direction="horizontal"
            gap={12}
            style={{ width: 'min(100%, 448px)' }}
          >
            <ModelSelect
              disabled={!canManage}
              showAbility={false}
              style={{ minWidth: 0, width: '100%' }}
              value={value}
              onChange={(props) => updateSystemAgentModel(key, props)}
            />
          </Flexbox>
        </Tooltip>
      );

      return {
        children:
          managedMetas.length > 0 ? (
            <ManagedCompositeSettingFieldContent metas={managedMetas}>
              {({ disabled }) => (
                <Tooltip title={disabledReason}>
                  <Flexbox
                    align="center"
                    direction="horizontal"
                    gap={12}
                    style={{ width: 'min(100%, 448px)' }}
                  >
                    <ModelSelect
                      disabled={disabled || !canManage}
                      showAbility={false}
                      style={{ minWidth: 0, width: '100%' }}
                      value={value}
                      onChange={(props) => updateSystemAgentModel(key, props)}
                    />
                  </Flexbox>
                </Tooltip>
              )}
            </ManagedCompositeSettingFieldContent>
          ) : (
            control
          ),
        desc: t(`systemAgent.${key}.modelDesc`),
        label: t(`systemAgent.${key}.title`),
      } satisfies FormItemProps;
    }).filter(Boolean) as FormItemProps[];

    const memoryModelItems: FormItemProps[] = MEMORY_MODEL_ITEMS.map(
      ({ contextLimit, key, modelType }) => {
        const value = systemAgentSettings[key];

        return {
          children: (
            <Flexbox direction="vertical" gap={8} style={{ width: 448 }}>
              <ModelSelect
                modelType={modelType}
                showAbility={false}
                style={{ minWidth: 0, width: '100%' }}
                value={value}
                onChange={(props) => updateSystemAgentModel(key, props)}
              />
              {contextLimit && (
                <ConfigProvider theme={{ token: { controlHeight: 32 } }}>
                  <InputNumber
                    min={1}
                    placeholder={t('serviceModel.contextLimit.placeholder')}
                    style={{ alignSelf: 'flex-end', width: 180 }}
                    value={value.contextLimit}
                    onChange={(nextLimit) =>
                      updateSystemAgentModel(key, {
                        contextLimit: typeof nextLimit === 'number' ? nextLimit : undefined,
                      })
                    }
                  />
                </ConfigProvider>
              )}
            </Flexbox>
          ),
          desc: t(`systemAgent.${key}.modelDesc`),
          label: t(`systemAgent.${key}.title`),
        } satisfies FormItemProps;
      },
    );

    const optionalFeatureItems: FormItemProps[] = OPTIONAL_FEATURE_ITEMS.map(({ key }) => {
      const value = systemAgentSettings[key];
      const featureDisabled = value.enabled === false;

      return {
        children: (
          <Tooltip title={disabledReason}>
            <Flexbox
              align="center"
              direction="horizontal"
              gap={12}
              style={{ width: 'min(100%, 448px)' }}
            >
              <ModelSelect
                disabled={!canManage}
                showAbility={false}
                style={{ minWidth: 0, width: '100%' }}
                value={value}
                onChange={(props) => updateSystemAgentModel(key, props)}
              />
              <Flexbox align="center" direction="horizontal" gap={8}>
                <Switch
                  aria-label={t(`systemAgent.${key}.title`)}
                  checked={value.enabled}
                  disabled={!canManage}
                  loading={loadingKey === key}
                  onChange={(enabled) => updateSystemAgentModel(key, { enabled })}
                />
              </Flexbox>
            </Flexbox>
          </Tooltip>
        ),
        desc: t(`systemAgent.${key}.modelDesc`),
        label: (
          <span
            style={{
              opacity: featureDisabled || !canManage ? 0.45 : 1,
            }}
          >
            {t(`systemAgent.${key}.title`)}
          </span>
        ),
      } satisfies FormItemProps;
    });

    const renderSaveHint = (group: SavingGroup) =>
      savingGroup === group && (
        <AutoSaveHint lastUpdatedTime={lastSavedAt} saveStatus={saveStatus} onRetry={retry} />
      );

    const modelAssignments: FormGroupItemType = {
      children: [...(defaultAgentItem ? [defaultAgentItem] : []), ...systemModelItems],
      extra: renderSaveHint('assignments'),
      title: t('serviceModel.modelAssignments.title'),
    };

    const optionalFeatures: FormGroupItemType = {
      children: optionalFeatureItems,
      extra: renderSaveHint('optional'),
      title: t('serviceModel.optionalFeatures.title'),
    };

    const memoryModels: FormGroupItemType = {
      children: memoryModelItems,
      extra: renderSaveHint('memory'),
      title: t('serviceModel.memoryModels.title'),
    };

    return (
      <Form
        collapsible={false}
        items={[modelAssignments, memoryModels, optionalFeatures]}
        itemsType={'group'}
        variant={'filled'}
        {...FORM_STYLE}
        itemMinWidth={undefined}
      />
    );
  },
);

ModelAssignmentsFormView.displayName = 'ModelAssignmentsFormView';

export default ModelAssignmentsFormView;
