import type { EffortLevel } from '@lobechat/model-runtime';
import type { LobeAgentChatConfig } from '@lobechat/types';
import type { FormItemProps } from '@lobehub/ui';
import type { TFunction } from 'i18next';

import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { LobeAgentSettings } from '@/types/session';
import type { SystemAgentItem, UserServiceModelConfigKey } from '@/types/user/settings';

import DefaultAgentRow from './DefaultAgentRow';
import MemoryModelRow from './MemoryModelRow';
import OptionalFeatureRow from './OptionalFeatureRow';
import SystemAgentModelRow from './SystemAgentModelRow';
import {
  isSystemAgentPolicyRowHidden,
  type LoadingKey,
  MEMORY_MODEL_ITEMS,
  OPTIONAL_FEATURE_ITEMS,
  SYSTEM_AGENT_MODEL_ITEMS,
  type SystemAgentPolicyMetas,
} from './systemAgentPolicy';
import type { ActiveEffortControl } from './useModelAssignmentsForm';

/** Everything the per-key system-agent rows need; identical across the three groups. */
export interface SystemAgentItemsContext {
  canManage: boolean;
  disabledReason?: string;
  loadingKey: LoadingKey | undefined;
  onUpdate: (key: UserServiceModelConfigKey, value: Partial<SystemAgentItem>) => Promise<void>;
  systemAgentMetas: Partial<Record<UserServiceModelConfigKey, SystemAgentPolicyMetas>>;
  systemAgentSettings: Record<UserServiceModelConfigKey, SystemAgentItem>;
  t: TFunction<'setting'>;
}

interface DefaultAgentItemContext {
  activeEffortMetas: PlatformSettingMetaState[];
  canManage: boolean;
  defaultAgent: LobeAgentSettings;
  defaultAgentEffortClearable: boolean;
  defaultAgentMetas: readonly PlatformSettingMetaState[];
  disabledReason?: string;
  effortControl: ActiveEffortControl;
  onUpdateEffort: (
    level: EffortLevel | undefined,
    configKey: keyof LobeAgentChatConfig,
  ) => Promise<void>;
  onUpdateModel: (value: { model: string; provider: string }) => Promise<void>;
  showEffortPicker: boolean;
  t: TFunction<'setting'>;
}

const isFormItem = <T,>(item: T | null): item is T => item !== null;

export const buildDefaultAgentItem = ({
  activeEffortMetas,
  canManage,
  defaultAgent,
  defaultAgentEffortClearable,
  defaultAgentMetas,
  disabledReason,
  effortControl,
  onUpdateEffort,
  onUpdateModel,
  showEffortPicker,
  t,
}: DefaultAgentItemContext): FormItemProps | undefined =>
  defaultAgentMetas.some((meta) => meta.hidden)
    ? undefined
    : {
        children: (
          <DefaultAgentRow
            activeEffortMetas={activeEffortMetas}
            canManage={canManage}
            defaultAgent={defaultAgent}
            disabledReason={disabledReason}
            effortClearable={defaultAgentEffortClearable}
            effortControl={effortControl}
            metas={defaultAgentMetas}
            showEffortPicker={showEffortPicker}
            onUpdateEffort={onUpdateEffort}
            onUpdateModel={onUpdateModel}
          />
        ),
        desc: t('defaultAgent.model.desc'),
        label: t('defaultAgent.title'),
      };

export const buildSystemModelItems = ({
  canManage,
  disabledReason,
  onUpdate,
  systemAgentMetas,
  systemAgentSettings,
  t,
}: SystemAgentItemsContext): FormItemProps[] =>
  SYSTEM_AGENT_MODEL_ITEMS.map(({ key }) => {
    const value = systemAgentSettings[key];
    const policy = systemAgentMetas[key];

    if (isSystemAgentPolicyRowHidden(policy)) return null;

    return {
      children: (
        <SystemAgentModelRow
          canManage={canManage}
          disabledReason={disabledReason}
          metas={policy?.modelProvider ?? []}
          value={value}
          onUpdate={(next) => onUpdate(key, next)}
        />
      ),
      desc: t(`systemAgent.${key}.modelDesc`),
      label: t(`systemAgent.${key}.title`),
    } satisfies FormItemProps;
  }).filter(isFormItem);

export const buildMemoryModelItems = ({
  canManage,
  onUpdate,
  systemAgentMetas,
  systemAgentSettings,
  t,
}: SystemAgentItemsContext): FormItemProps[] =>
  MEMORY_MODEL_ITEMS.map(({ contextLimit, key, modelType }) => {
    const value = systemAgentSettings[key];
    const policy = systemAgentMetas[key];
    if (isSystemAgentPolicyRowHidden(policy)) return null;

    return {
      children: (
        <MemoryModelRow
          canManage={canManage}
          contextLimitMetas={policy?.contextLimit ? [policy.contextLimit] : []}
          contextLimitPlaceholder={t('serviceModel.contextLimit.placeholder')}
          metas={policy?.modelProvider ?? []}
          modelType={modelType}
          showContextLimit={Boolean(contextLimit)}
          value={value}
          onUpdate={(next) => onUpdate(key, next)}
        />
      ),
      desc: t(`systemAgent.${key}.modelDesc`),
      label: t(`systemAgent.${key}.title`),
    } satisfies FormItemProps;
  }).filter(isFormItem);

export const buildOptionalFeatureItems = ({
  canManage,
  disabledReason,
  loadingKey,
  onUpdate,
  systemAgentMetas,
  systemAgentSettings,
  t,
}: SystemAgentItemsContext): FormItemProps[] =>
  OPTIONAL_FEATURE_ITEMS.map(({ key }) => {
    const value = systemAgentSettings[key];
    const featureDisabled = value.enabled === false;
    const policy = systemAgentMetas[key];
    if (isSystemAgentPolicyRowHidden(policy)) return null;

    return {
      children: (
        <OptionalFeatureRow
          ariaLabel={t(`systemAgent.${key}.title`)}
          canManage={canManage}
          disabledReason={disabledReason}
          enabledMetas={policy?.enabled ? [policy.enabled] : []}
          loading={loadingKey === key}
          metas={policy?.modelProvider ?? []}
          value={value}
          onUpdate={(next) => onUpdate(key, next)}
        />
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
  }).filter(isFormItem);
