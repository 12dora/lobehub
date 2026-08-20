'use client';

import type { EffortLevel } from '@lobechat/model-runtime';
import type { LobeAgentChatConfig } from '@lobechat/types';
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

import EffortSelect from './EffortSelect';

/** Leaves the model picker + its effort picker edit as one atomic control cluster. */
const ROW_STYLE = { width: 'min(100%, 448px)' } as const;
const MODEL_SELECT_STYLE = { minWidth: 0, width: '100%' } as const;

export interface SystemAgentModelItem {
  contextLimit?: boolean;
  key: UserServiceModelConfigKey;
  modelType?: 'chat' | 'embedding';
}

export interface SystemAgentPolicyMetas {
  contextLimit?: PlatformSettingMetaState;
  enabled?: PlatformSettingMetaState;
  /**
   * Leaves the single model picker cluster writes atomically:
   * `model`, `provider` and (where registered) `reasoningEffort`.
   */
  modelProvider: readonly PlatformSettingMetaState[];
}

export const getSystemAgentPatchMetas = (
  policy: SystemAgentPolicyMetas | undefined,
  value: Partial<SystemAgentItem>,
): PlatformSettingMetaState[] => [
  ...('model' in value || 'provider' in value || 'reasoningEffort' in value
    ? (policy?.modelProvider ?? [])
    : []),
  ...('enabled' in value && policy?.enabled ? [policy.enabled] : []),
  ...('contextLimit' in value && policy?.contextLimit ? [policy.contextLimit] : []),
];

export const isSystemAgentPolicyRowHidden = (policy: SystemAgentPolicyMetas | undefined) =>
  Boolean(
    policy?.modelProvider.some((meta) => meta.hidden) ||
    policy?.enabled?.hidden ||
    policy?.contextLimit?.hidden,
  );

type LoadingKey = 'defaultAgent' | UserServiceModelConfigKey;
type SavingGroup = 'assignments' | 'memory' | 'optional';

/**
 * Local-edit InputNumber that commits on blur / Enter only (avoids per-keystroke publish).
 * Clear (empty) commits `undefined` so callers can map to registry null.
 */
const ContextLimitInput = memo<{
  canManage: boolean;
  onCommit: (value: number | undefined) => void;
  placeholder?: string;
  value?: number;
}>(({ canManage, onCommit, placeholder, value }) => {
  const [draft, setDraft] = useState<number | null | undefined>(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (!canManage) return;
    const next = typeof draft === 'number' ? draft : undefined;
    const prev = typeof value === 'number' ? value : undefined;
    if (next === prev) return;
    onCommit(next);
  };

  return (
    <ConfigProvider theme={{ token: { controlHeight: 32 } }}>
      <InputNumber
        disabled={!canManage}
        min={1}
        placeholder={placeholder}
        // Left-aligned under the model select. `alignSelf` used to be inert on the user side
        // (managed metas wrap the control in a plain div) and only applied on admin — which
        // made the two surfaces disagree.
        style={{ width: 180 }}
        value={draft as number | undefined}
        onBlur={commit}
        onChange={(next) => setDraft(typeof next === 'number' ? next : null)}
        onPressEnter={commit}
      />
    </ConfigProvider>
  );
});

ContextLimitInput.displayName = 'ContextLimitInput';

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
  /**
   * Default-assistant thinking effort. Stored on the agent's own `chatConfig` under the
   * model's registry `configKey`. User settings write via `updateDefaultAgent`; admin
   * platform defaults write via `applyImmediate` on `defaultAgent.config.chatConfig.<configKey>`.
   * Omit this prop to hide the picker (tests / surfaces that cannot persist effort).
   */
  onUpdateDefaultAgentEffort?: (value: {
    configKey: keyof LobeAgentChatConfig;
    /** Always a concrete level — chatConfig mode offers no clear. */
    level: EffortLevel;
  }) => Promise<void> | void;
  onUpdateSystemAgent: (
    key: UserServiceModelConfigKey,
    value: Partial<SystemAgentItem>,
  ) => Promise<void> | void;
  saveState: Pick<ReturnType<typeof useSaveState>, 'lastSavedAt' | 'retry' | 'save' | 'status'>;
  systemAgentMetas?: Partial<Record<UserServiceModelConfigKey, SystemAgentPolicyMetas>>;
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
    onUpdateDefaultAgentEffort,
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
        await save(async () => {
          await onUpdateDefaultAgent({ model, provider });
        });
      } finally {
        setLoadingKey(undefined);
      }
    };

    /**
     * Unlike the systemAgent leaves — which persist an explicit `null` to clear — the default
     * assistant stores its level on `chatConfig`, whose fields are strict level unions with no
     * null member, and the settings merge drops `undefined`. A clear is therefore not
     * representable, so `EffortSelect` omits the "Default" option in chatConfig mode and only
     * ever emits a concrete level here. The guard below keeps that contract enforced rather
     * than assumed: a clear would silently no-op, which is worse than not offering it.
     */
    const updateDefaultAgentEffort = async (
      level: EffortLevel | undefined,
      configKey: keyof LobeAgentChatConfig,
    ) => {
      if (!onUpdateDefaultAgentEffort || level === undefined) return;
      if (!canManage || defaultAgentMetas.some((meta) => !isPlatformSettingMetaWritable(meta)))
        return;

      setSavingGroup('assignments');
      setLoadingKey('defaultAgent');
      try {
        await save(async () => {
          await onUpdateDefaultAgentEffort({ configKey, level });
        });
      } finally {
        setLoadingKey(undefined);
      }
    };

    const updateSystemAgentModel = async (
      key: UserServiceModelConfigKey,
      value: Partial<SystemAgentItem>,
    ) => {
      const policy = systemAgentMetas[key];
      const managedMetas = getSystemAgentPatchMetas(policy, value);
      if (!canManage || managedMetas.some((meta) => !isPlatformSettingMetaWritable(meta))) return;

      setSavingGroup(groupOfKey(key));
      setLoadingKey(key);
      try {
        await save(async () => {
          await onUpdateSystemAgent(key, value);
        });
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
                  <Flexbox align="center" direction="horizontal" gap={12} style={ROW_STYLE}>
                    <ModelSelect
                      disabled={disabled || !canManage}
                      showAbility={false}
                      style={MODEL_SELECT_STYLE}
                      value={defaultAgent.config}
                      onChange={updateDefaultAgentModel}
                    />
                    {onUpdateDefaultAgentEffort && (
                      <EffortSelect
                        chatConfig={defaultAgent.config.chatConfig}
                        disabled={disabled || !canManage}
                        model={defaultAgent.config.model}
                        provider={defaultAgent.config.provider ?? ''}
                        onChange={updateDefaultAgentEffort}
                      />
                    )}
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
      const policy = systemAgentMetas[key];
      const managedMetas = policy?.modelProvider ?? [];

      if (isSystemAgentPolicyRowHidden(policy)) return null;

      return {
        // An empty meta list renders the children unmanaged, so one branch covers both
        // the policy-enabled user page and the admin platform-defaults page.
        children: (
          <ManagedCompositeSettingFieldContent metas={managedMetas}>
            {({ disabled }) => (
              <Tooltip title={disabledReason}>
                <Flexbox align="center" direction="horizontal" gap={12} style={ROW_STYLE}>
                  <ModelSelect
                    disabled={disabled || !canManage}
                    showAbility={false}
                    style={MODEL_SELECT_STYLE}
                    value={value}
                    onChange={(props) => updateSystemAgentModel(key, props)}
                  />
                  <EffortSelect
                    disabled={disabled || !canManage}
                    model={value.model}
                    provider={value.provider}
                    value={value.reasoningEffort}
                    onChange={(level) =>
                      updateSystemAgentModel(key, { reasoningEffort: level ?? null })
                    }
                  />
                </Flexbox>
              </Tooltip>
            )}
          </ManagedCompositeSettingFieldContent>
        ),
        desc: t(`systemAgent.${key}.modelDesc`),
        label: t(`systemAgent.${key}.title`),
      } satisfies FormItemProps;
    }).filter(Boolean) as FormItemProps[];

    const memoryModelItems: FormItemProps[] = MEMORY_MODEL_ITEMS.map(
      ({ contextLimit, key, modelType }) => {
        const value = systemAgentSettings[key];
        const policy = systemAgentMetas[key];
        const modelProviderMetas = policy?.modelProvider ?? [];
        if (isSystemAgentPolicyRowHidden(policy)) return null;

        return {
          children: (
            <Flexbox direction="vertical" gap={8} style={{ width: 448 }}>
              <ManagedCompositeSettingFieldContent metas={modelProviderMetas}>
                {({ disabled }) => (
                  <Flexbox align="center" direction="horizontal" gap={12}>
                    <ModelSelect
                      disabled={disabled || !canManage}
                      modelType={modelType}
                      showAbility={false}
                      style={MODEL_SELECT_STYLE}
                      value={value}
                      onChange={(props) => updateSystemAgentModel(key, props)}
                    />
                    {/* Embedding models have no thinking budget — only the two chat
                     * memory agents (analysis / persona writer) get an effort picker. */}
                    {modelType !== 'embedding' && (
                      <EffortSelect
                        disabled={disabled || !canManage}
                        model={value.model}
                        provider={value.provider}
                        value={value.reasoningEffort}
                        onChange={(level) =>
                          updateSystemAgentModel(key, { reasoningEffort: level ?? null })
                        }
                      />
                    )}
                  </Flexbox>
                )}
              </ManagedCompositeSettingFieldContent>
              {contextLimit && (
                <ManagedCompositeSettingFieldContent
                  metas={policy?.contextLimit ? [policy.contextLimit] : []}
                >
                  {({ disabled }) => (
                    <ContextLimitInput
                      canManage={canManage && !disabled}
                      placeholder={t('serviceModel.contextLimit.placeholder')}
                      value={value.contextLimit}
                      onCommit={(nextLimit) =>
                        updateSystemAgentModel(key, { contextLimit: nextLimit })
                      }
                    />
                  )}
                </ManagedCompositeSettingFieldContent>
              )}
            </Flexbox>
          ),
          desc: t(`systemAgent.${key}.modelDesc`),
          label: t(`systemAgent.${key}.title`),
        } satisfies FormItemProps;
      },
    ).filter(Boolean) as FormItemProps[];

    const optionalFeatureItems: FormItemProps[] = OPTIONAL_FEATURE_ITEMS.map(({ key }) => {
      const value = systemAgentSettings[key];
      const featureDisabled = value.enabled === false;
      const policy = systemAgentMetas[key];
      const modelProviderMetas = policy?.modelProvider ?? [];
      if (isSystemAgentPolicyRowHidden(policy)) return null;

      return {
        children: (
          <Tooltip title={disabledReason}>
            <Flexbox align="center" direction="horizontal" gap={12} style={ROW_STYLE}>
              <ManagedCompositeSettingFieldContent metas={modelProviderMetas}>
                {({ disabled }) => (
                  <Flexbox align="center" direction="horizontal" gap={12}>
                    <ModelSelect
                      disabled={disabled || !canManage}
                      showAbility={false}
                      style={MODEL_SELECT_STYLE}
                      value={value}
                      onChange={(props) => updateSystemAgentModel(key, props)}
                    />
                    <EffortSelect
                      disabled={disabled || !canManage}
                      model={value.model}
                      provider={value.provider}
                      value={value.reasoningEffort}
                      onChange={(level) =>
                        updateSystemAgentModel(key, { reasoningEffort: level ?? null })
                      }
                    />
                  </Flexbox>
                )}
              </ManagedCompositeSettingFieldContent>
              <ManagedCompositeSettingFieldContent metas={policy?.enabled ? [policy.enabled] : []}>
                {({ disabled }) => (
                  <Flexbox align="center" direction="horizontal" gap={8}>
                    <Switch
                      aria-label={t(`systemAgent.${key}.title`)}
                      checked={value.enabled}
                      disabled={disabled || !canManage}
                      loading={loadingKey === key}
                      onChange={(enabled) => updateSystemAgentModel(key, { enabled })}
                    />
                  </Flexbox>
                )}
              </ManagedCompositeSettingFieldContent>
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
    }).filter(Boolean) as FormItemProps[];

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
