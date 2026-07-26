import isEqual from 'fast-deep-equal';
import type { PartialDeep } from 'type-fest';

import { MESSAGE_CANCEL_FLAT } from '@/const/message';
import { shareService } from '@/services/share';
import { userService } from '@/services/user';
import type { StoreSetter } from '@/store/types';
import type { UserStore } from '@/store/user';
import type { LobeAgentSettings } from '@/types/session';
import type {
  SystemAgentItem,
  UserGeneralConfig,
  UserKeyVaults,
  UserServiceModelConfigKey,
  UserSettings,
  UserSystemAgentConfigKey,
} from '@/types/user/settings';
import { difference } from '@/utils/difference';
import { merge } from '@/utils/merge';

import { settingsSelectors } from './selectors/settings';

type Setter = StoreSetter<UserStore>;

type SystemAgentDiff = Partial<Record<string, unknown>>;

export const createSettingsSlice = (set: Setter, get: () => UserStore, _api?: unknown) =>
  new UserSettingsActionImpl(set, get, _api);

export class UserSettingsActionImpl {
  readonly #get: () => UserStore;
  readonly #pendingSettingGroups = new Set<keyof UserSettings>();
  readonly #pendingSettingValues = new Map<keyof UserSettings, unknown>();
  readonly #set: Setter;
  #resetMutationPromise: Promise<AbortController> | null = null;
  #resetOperationPromise: Promise<void> | null = null;

  constructor(set: Setter, get: () => UserStore, _api?: unknown) {
    void _api;
    this.#set = set;
    this.#get = get;
  }

  #restorePendingSettingGroups = (): void => {
    const pendingSettings = Object.fromEntries(
      [...this.#pendingSettingGroups].flatMap((key) =>
        this.#pendingSettingValues.has(key)
          ? [[key, this.#pendingSettingValues.get(key)] as const]
          : [],
      ),
    ) as PartialDeep<UserSettings>;

    if (Object.keys(pendingSettings).length === 0) return;

    this.#set(
      { settings: merge(this.#get().settings, pendingSettings) },
      false,
      'restore_pendingSettings_after_staleRefresh',
    );
  };

  #runResetMutation = async (): Promise<AbortController> => {
    const previousSettings = this.#get().settings;
    const previousPendingGroups = new Set(this.#pendingSettingGroups);
    const previousPendingValues = new Map(this.#pendingSettingValues);
    const resetController = this.internal_createSignal();

    this.#pendingSettingGroups.clear();
    this.#pendingSettingValues.clear();
    this.#set({ settings: {} }, false, 'resetSettings/clearPending');

    try {
      await userService.resetUserSettings();
    } catch (error) {
      // The server rejected the reset, so {} is not an authoritative local state. Restore the
      // previous view immediately, then prefer a fresh server snapshot. If reconciliation also
      // fails, restore the prior pending queue so its optimistic values remain retryable.
      this.#set({ settings: previousSettings }, false, 'resetSettings/rollback');
      try {
        await this.#get().refreshUserState();
      } catch {
        this.#pendingSettingGroups.clear();
        this.#pendingSettingValues.clear();
        for (const key of previousPendingGroups) this.#pendingSettingGroups.add(key);
        for (const [key, value] of previousPendingValues) {
          this.#pendingSettingValues.set(key, value);
        }
        this.#restorePendingSettingGroups();
      }
      throw error;
    }

    return resetController;
  };

  #runResetOperation = async (): Promise<void> => {
    const resetMutationPromise = this.#runResetMutation();
    this.#resetMutationPromise = resetMutationPromise;

    let resetController: AbortController;
    try {
      resetController = await resetMutationPromise;
    } finally {
      if (this.#resetMutationPromise === resetMutationPromise) {
        this.#resetMutationPromise = null;
      }
    }

    if (this.#get().updateSettingsSignal !== resetController) return;

    await this.#get().refreshUserState();
    if (this.#get().updateSettingsSignal !== resetController) {
      this.#restorePendingSettingGroups();
    }
  };

  addToolToAllowList = async (toolKey: string): Promise<void> => {
    const currentAllowList = this.#get().settings.tool?.humanIntervention?.allowList || [];

    if (currentAllowList.includes(toolKey)) return;

    await this.#get().setSettings({
      tool: {
        humanIntervention: {
          allowList: [...currentAllowList, toolKey],
        },
      },
    });
  };

  importAppSettings = async (importAppSettings: UserSettings): Promise<void> => {
    const { setSettings } = this.#get();

    await setSettings(importAppSettings);
  };

  importUrlShareSettings = async (settingsParams: string | null): Promise<void> => {
    if (settingsParams) {
      const importSettings = shareService.decodeShareSettings(settingsParams);
      if (importSettings?.message || !importSettings?.data) {
        // handle some error
        return;
      }

      await this.#get().setSettings(importSettings.data);
    }
  };

  internal_createSignal = (): AbortController => {
    const abortController = this.#get().updateSettingsSignal;
    if (abortController && !abortController.signal.aborted)
      abortController.abort(MESSAGE_CANCEL_FLAT);

    const newSignal = new AbortController();

    this.#set({ updateSettingsSignal: newSignal }, false, 'signalForUpdateSettings');

    return newSignal;
  };

  resetSettings = async (): Promise<void> => {
    if (this.#resetOperationPromise) {
      await this.#resetOperationPromise;
      return;
    }

    const resetOperationPromise = this.#runResetOperation();
    this.#resetOperationPromise = resetOperationPromise;
    try {
      await resetOperationPromise;
    } finally {
      if (this.#resetOperationPromise === resetOperationPromise) {
        this.#resetOperationPromise = null;
      }
    }
  };

  setSettings = async (settings: PartialDeep<UserSettings>): Promise<void> => {
    // Only the authoritative reset mutation is a write barrier. A best-effort freshness refresh
    // may fail after the server reset has committed; post-reset edits must still be allowed to
    // persist instead of inheriting that refresh failure.
    if (this.#resetMutationPromise) await this.#resetMutationPromise;

    // A refresh applies its snapshot before its promise continuation can observe a generation
    // change. Reapply pending values synchronously before deriving the next mutation so a user
    // action in that narrow window cannot prune an optimistic group from the coalesced write.
    this.#restorePendingSettingGroups();

    const { settings: prevSetting, defaultSettings } = this.#get();

    const nextSettings = merge(prevSetting, settings);

    if (isEqual(prevSetting, nextSettings)) return;

    const diffs = difference(nextSettings, defaultSettings);
    const isEmptyObjectDiff = (value: unknown): boolean =>
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0;

    // When user resets a field to default value, we need to explicitly include it in diffs
    // to override the previously saved non-default value in the backend
    const changedFields = difference(nextSettings, prevSetting);
    for (const key of Object.keys(changedFields)) {
      // Only handle fields that were previously set by user (exist in prevSetting)
      const keyDiff = (diffs as any)[key];
      if (key in prevSetting && (!(key in diffs) || isEmptyObjectDiff(keyDiff))) {
        (diffs as any)[key] = (changedFields as any)[key];
      }
    }

    const nextDefaultAgentConfig = nextSettings.defaultAgent?.config;
    const changedDefaultAgentConfig = changedFields.defaultAgent?.config;
    const hasDefaultAgentModelProviderChange =
      !!changedDefaultAgentConfig &&
      ('model' in changedDefaultAgentConfig || 'provider' in changedDefaultAgentConfig);
    const defaultAgentModelProviderDiffersFromDefault =
      nextDefaultAgentConfig?.model !== defaultSettings.defaultAgent?.config?.model ||
      nextDefaultAgentConfig?.provider !== defaultSettings.defaultAgent?.config?.provider;

    if (
      hasDefaultAgentModelProviderChange &&
      (defaultAgentModelProviderDiffersFromDefault || 'defaultAgent' in prevSetting) &&
      nextDefaultAgentConfig?.model &&
      nextDefaultAgentConfig.provider
    ) {
      const defaultAgentDiff = diffs.defaultAgent || {};
      const configDiff = defaultAgentDiff.config || {};

      diffs.defaultAgent = {
        ...defaultAgentDiff,
        config: {
          ...configDiff,
          model: nextDefaultAgentConfig.model,
          provider: nextDefaultAgentConfig.provider,
        },
      };
    }

    const changedSystemAgent = changedFields.systemAgent as SystemAgentDiff | undefined;
    const nextSystemAgent = nextSettings.systemAgent;
    const previousSystemAgent = prevSetting.systemAgent;
    const defaultSystemAgent = defaultSettings.systemAgent;

    if (changedSystemAgent && nextSystemAgent) {
      const mutableDiffs = diffs as PartialDeep<UserSettings> & { systemAgent?: SystemAgentDiff };

      for (const key of Object.keys(changedSystemAgent)) {
        const changedSystemAgentItem = changedSystemAgent[key];
        if (
          !changedSystemAgentItem ||
          typeof changedSystemAgentItem !== 'object' ||
          Array.isArray(changedSystemAgentItem) ||
          (!('model' in changedSystemAgentItem) && !('provider' in changedSystemAgentItem))
        )
          continue;

        const taskKey = key as UserSystemAgentConfigKey;
        const nextSystemAgentItem = nextSystemAgent[taskKey];
        const defaultSystemAgentItem = defaultSystemAgent?.[taskKey];
        const systemAgentModelProviderDiffersFromDefault =
          nextSystemAgentItem?.model !== defaultSystemAgentItem?.model ||
          nextSystemAgentItem?.provider !== defaultSystemAgentItem?.provider;

        if (
          (!systemAgentModelProviderDiffersFromDefault &&
            (!previousSystemAgent || !Object.hasOwn(previousSystemAgent, taskKey))) ||
          !nextSystemAgentItem?.model ||
          !nextSystemAgentItem.provider
        )
          continue;

        const systemAgentDiff = mutableDiffs.systemAgent || {};
        const systemAgentItemDiff = systemAgentDiff[taskKey] || {};

        mutableDiffs.systemAgent = {
          ...systemAgentDiff,
          [taskKey]: {
            ...systemAgentItemDiff,
            model: nextSystemAgentItem.model,
            provider: nextSystemAgentItem.provider,
          },
        };
      }
    }

    this.#set({ settings: diffs }, false, 'optimistic_updateSettings');

    const carriedGroups = new Set(this.#pendingSettingGroups);
    const carriedValues = new Map(
      [...carriedGroups].flatMap((key) =>
        this.#pendingSettingValues.has(key)
          ? [[key, this.#pendingSettingValues.get(key)] as const]
          : [],
      ),
    );
    for (const key of Object.keys(changedFields) as (keyof UserSettings)[]) {
      if (Object.hasOwn(diffs, key)) {
        this.#pendingSettingGroups.add(key);
        this.#pendingSettingValues.set(key, diffs[key]);
      }
    }

    // Persist only pending top-level setting groups. A newer mutation aborts the prior request,
    // so it must also carry every still-pending group or a cross-group edit can be lost.
    // `diffs` is the complete local override state and can include unrelated
    // credential-bearing groups (for example `languageModel`). Sending that
    // entire object makes a harmless general-settings update fail the managed
    // settings policy before it reaches the intended field.
    const groupsInRequest = [...this.#pendingSettingGroups];
    const updates = Object.fromEntries(
      groupsInRequest.flatMap((key) =>
        this.#pendingSettingValues.has(key)
          ? [[key, this.#pendingSettingValues.get(key)] as const]
          : [],
      ),
    ) as PartialDeep<UserSettings>;

    const abortController = this.#get().internal_createSignal();
    try {
      await userService.updateUserSettings(updates, abortController.signal);
      // An adapter can still resolve after its signal was aborted. Only the request that still
      // owns the store controller may clear pending groups or refresh from the server; otherwise
      // an obsolete response can replace a newer optimistic edit with stale persisted state.
      if (this.#get().updateSettingsSignal !== abortController) return;

      await this.#get().refreshUserState();
      if (this.#get().updateSettingsSignal !== abortController) {
        // refreshUserState applies its snapshot before resolving. If a newer edit took ownership
        // while this refresh was in flight, restore every still-pending optimistic group that the
        // stale snapshot may have overwritten.
        this.#restorePendingSettingGroups();
        return;
      }

      for (const key of groupsInRequest) {
        this.#pendingSettingGroups.delete(key);
        this.#pendingSettingValues.delete(key);
      }
    } catch (error) {
      // Only the latest mutation owns the optimistic state. An older request can
      // reject after internal_createSignal aborts it, but rolling that request
      // back would overwrite the newer mutation that superseded it.
      if (this.#get().updateSettingsSignal === abortController) {
        // Keep groups inherited from an aborted older request pending. They have never received a
        // definitive persistence result and must ride the next write even when this coalesced
        // request fails. Only groups introduced by the failed latest invocation are rolled back.
        for (const key of groupsInRequest) {
          if (carriedGroups.has(key)) {
            if (carriedValues.has(key)) this.#pendingSettingValues.set(key, carriedValues.get(key));
          } else {
            this.#pendingSettingGroups.delete(key);
            this.#pendingSettingValues.delete(key);
          }
        }
        this.#set({ settings: prevSetting }, false, 'rollback_updateSettings');
      }

      throw error;
    }
  };

  updateDefaultAgent = async (defaultAgent: PartialDeep<LobeAgentSettings>): Promise<void> => {
    const config = defaultAgent.config;
    const shouldNormalizeModelProvider =
      config && (config.model !== undefined || config.provider !== undefined);

    if (!shouldNormalizeModelProvider) {
      await this.#get().setSettings({ defaultAgent });
      return;
    }

    const currentConfig = settingsSelectors.defaultAgentConfig(this.#get());

    await this.#get().setSettings({
      defaultAgent: {
        ...defaultAgent,
        config: {
          ...config,
          model: config.model ?? currentConfig.model,
          provider: config.provider ?? currentConfig.provider,
        },
      },
    });
  };

  updateGeneralConfig = async (general: Partial<UserGeneralConfig>): Promise<void> => {
    await this.#get().setSettings({ general });
  };

  updateHumanIntervention = async (config: {
    allowList?: string[];
    approvalMode?: 'auto-run' | 'allow-list' | 'manual';
  }): Promise<void> => {
    const current = this.#get().settings.tool?.humanIntervention || {};
    await this.#get().setSettings({
      tool: {
        humanIntervention: { ...current, ...config },
      },
    });
  };

  updateKeyVaults = async (keyVaults: Partial<UserKeyVaults>): Promise<void> => {
    await this.#get().setSettings({ keyVaults });
  };

  updateSystemAgent = async (
    key: UserServiceModelConfigKey,
    value: Partial<SystemAgentItem>,
  ): Promise<void> => {
    await this.#get().setSettings({
      systemAgent: { [key]: { ...value } },
    });
  };
}

export type UserSettingsAction = Pick<UserSettingsActionImpl, keyof UserSettingsActionImpl>;
