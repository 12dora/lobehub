import type { EffortControlKey, EffortLevel } from '@lobechat/model-runtime';
import { findEffortControl } from '@lobechat/model-runtime';
import type { LobeAgentChatConfig } from '@lobechat/types';
import { useEffect, useMemo, useState } from 'react';

import {
  isPlatformSettingMetaWritable,
  type PlatformSettingMetaState,
} from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { useSaveState } from '@/hooks/useSaveState';
import { aiModelSelectors, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';
import type { LobeAgentSettings } from '@/types/session';
import type { SystemAgentItem, UserServiceModelConfigKey } from '@/types/user/settings';

import {
  getSystemAgentPatchMetas,
  type LoadingKey,
  type SavingGroup,
  savingGroupOfKey,
  type SystemAgentPolicyMetas,
} from './systemAgentPolicy';

export type ActiveEffortControl = ReturnType<typeof findEffortControl>;

type SaveFn = ReturnType<typeof useSaveState>['save'];

interface UseModelAssignmentsFormParams {
  canManage: boolean;
  defaultAgent: LobeAgentSettings;
  defaultAgentEffortClearable: boolean;
  defaultAgentEffortMetas: Partial<Record<EffortControlKey, PlatformSettingMetaState>>;
  defaultAgentMetas: readonly PlatformSettingMetaState[];
  onUpdateDefaultAgent: (value: { model: string; provider: string }) => Promise<void> | void;
  onUpdateDefaultAgentEffort?: (value: {
    configKey: keyof LobeAgentChatConfig;
    level: EffortLevel | undefined;
  }) => Promise<void> | void;
  onUpdateSystemAgent: (
    key: UserServiceModelConfigKey,
    value: Partial<SystemAgentItem>,
  ) => Promise<void> | void;
  save: SaveFn;
  systemAgentMetas: Partial<Record<UserServiceModelConfigKey, SystemAgentPolicyMetas>>;
}

/**
 * Owns the form's write path: which row is in flight, which group shows the save hint,
 * and the platform-policy gate every write has to clear before it reaches the surface.
 */
export const useModelAssignmentsForm = ({
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
}: UseModelAssignmentsFormParams) => {
  const [loadingKey, setLoadingKey] = useState<LoadingKey>();
  const [savingGroup, setSavingGroup] = useState<SavingGroup>();
  const extendParams = useAiInfraStore(
    aiModelSelectors.modelExtendParams(
      defaultAgent.config.model,
      defaultAgent.config.provider ?? '',
    ),
  );
  const effortControl = useMemo(() => findEffortControl(extendParams), [extendParams]);
  const activeEffortMeta = effortControl ? defaultAgentEffortMetas[effortControl.key] : undefined;
  const activeEffortMetas = activeEffortMeta ? [activeEffortMeta] : [];

  useEffect(() => {
    if (loadingKey === 'defaultAgent') setLoadingKey(undefined);
  }, [defaultAgent.config.model, defaultAgent.config.provider, loadingKey]);

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
   * User chatConfig cannot persist a clear (merge drops `undefined`). Admin
   * `defaultAgentEffortClearable` forwards `undefined` so applyImmediate can delete
   * the policy row. Effort lock/hide is the active model's key only — inactive
   * family leaves must not disable this picker.
   */
  const updateDefaultAgentEffort = async (
    level: EffortLevel | undefined,
    configKey: keyof LobeAgentChatConfig,
  ) => {
    if (!onUpdateDefaultAgentEffort) return;
    if (level === undefined && !defaultAgentEffortClearable) return;
    if (!canManage) return;
    if (activeEffortMeta && !isPlatformSettingMetaWritable(activeEffortMeta)) return;

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

    setSavingGroup(savingGroupOfKey(key));
    setLoadingKey(key);
    try {
      await save(async () => {
        await onUpdateSystemAgent(key, value);
      });
    } finally {
      setLoadingKey(undefined);
    }
  };

  return {
    activeEffortMetas,
    effortControl,
    loadingKey,
    savingGroup,
    updateDefaultAgentEffort,
    updateDefaultAgentModel,
    updateSystemAgentModel,
  };
};
