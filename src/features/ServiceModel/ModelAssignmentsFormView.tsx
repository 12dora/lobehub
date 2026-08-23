'use client';

import type { EffortControlKey, EffortLevel } from '@lobechat/model-runtime';
import type { LobeAgentChatConfig } from '@lobechat/types';
import type { FormGroupItemType } from '@lobehub/ui';
import { Form, Skeleton } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import AutoSaveHint from '@/components/Editor/AutoSaveHint';
import { FORM_STYLE } from '@/const/layoutTokens';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { useSaveState } from '@/hooks/useSaveState';
import type { LobeAgentSettings } from '@/types/session';
import type { SystemAgentItem, UserServiceModelConfigKey } from '@/types/user/settings';

import { EMPTY_EFFORT_METAS } from './const';
import {
  buildDefaultAgentItem,
  buildMemoryModelItems,
  buildOptionalFeatureItems,
  buildSystemModelItems,
  type SystemAgentItemsContext,
} from './modelAssignmentItems';
import type { SavingGroup, SystemAgentPolicyMetas } from './systemAgentPolicy';
import { useModelAssignmentsForm } from './useModelAssignmentsForm';

export {
  getSystemAgentPatchMetas,
  isSystemAgentPolicyRowHidden,
  MEMORY_MODEL_ITEMS,
  OPTIONAL_FEATURE_ITEMS,
  SYSTEM_AGENT_MODEL_ITEMS,
  type SystemAgentModelItem,
  type SystemAgentPolicyMetas,
} from './systemAgentPolicy';

export interface ModelAssignmentsFormViewProps {
  canManage: boolean;
  defaultAgent: LobeAgentSettings;
  /**
   * When true, EffortSelect runs in value mode (shows "Default") and `level: undefined`
   * is forwarded so admin can delete the policy row. User settings omit this — chatConfig
   * cannot persist a clear.
   */
  defaultAgentEffortClearable?: boolean;
  /** Per EffortControlKey platform meta — only the selected model's key gates the picker. */
  defaultAgentEffortMetas?: Partial<Record<EffortControlKey, PlatformSettingMetaState>>;
  /** Platform-managed meta for the model/provider composite (optional — omit on admin). */
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
    /** `undefined` only when `defaultAgentEffortClearable` — deletes the policy row. */
    level: EffortLevel | undefined;
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
    defaultAgentEffortClearable = false,
    defaultAgentEffortMetas = EMPTY_EFFORT_METAS,
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
    const { status: saveStatus, lastSavedAt, save, retry } = saveState;
    const {
      activeEffortMetas,
      effortControl,
      loadingKey,
      savingGroup,
      updateDefaultAgentEffort,
      updateDefaultAgentModel,
      updateSystemAgentModel,
    } = useModelAssignmentsForm({
      canManage,
      defaultAgent,
      defaultAgentEffortClearable,
      defaultAgentEffortMetas,
      defaultAgentMetas,
      onUpdateDefaultAgent,
      onUpdateDefaultAgentEffort,
      onUpdateSystemAgent,
      save,
      systemAgentMetas,
    });

    if (!isInit) {
      if (initError)
        return <AsyncError error={initError} variant={'block'} onRetry={() => onRetryInit?.()} />;
      return <Skeleton active paragraph={{ rows: 8 }} title={false} />;
    }

    const itemsContext: SystemAgentItemsContext = {
      canManage,
      disabledReason,
      loadingKey,
      onUpdate: updateSystemAgentModel,
      systemAgentMetas,
      systemAgentSettings,
      t,
    };

    const defaultAgentItem = buildDefaultAgentItem({
      activeEffortMetas,
      canManage,
      defaultAgent,
      defaultAgentEffortClearable,
      defaultAgentMetas,
      disabledReason,
      effortControl,
      showEffortPicker: Boolean(onUpdateDefaultAgentEffort),
      t,
      onUpdateEffort: updateDefaultAgentEffort,
      onUpdateModel: updateDefaultAgentModel,
    });

    const renderSaveHint = (group: SavingGroup) =>
      savingGroup === group && (
        <AutoSaveHint lastUpdatedTime={lastSavedAt} saveStatus={saveStatus} onRetry={retry} />
      );

    const modelAssignments: FormGroupItemType = {
      children: [
        ...(defaultAgentItem ? [defaultAgentItem] : []),
        ...buildSystemModelItems(itemsContext),
      ],
      extra: renderSaveHint('assignments'),
      title: t('serviceModel.modelAssignments.title'),
    };

    const optionalFeatures: FormGroupItemType = {
      children: buildOptionalFeatureItems(itemsContext),
      extra: renderSaveHint('optional'),
      title: t('serviceModel.optionalFeatures.title'),
    };

    const memoryModels: FormGroupItemType = {
      children: buildMemoryModelItems(itemsContext),
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
