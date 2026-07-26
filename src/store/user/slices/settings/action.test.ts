import { DEFAULT_SETTINGS } from '@lobechat/config';
import { act, renderHook } from '@testing-library/react';
import type { PartialDeep } from 'type-fest';
import { describe, expect, it, vi } from 'vitest';

import { userService } from '@/services/user';
import { useUserStore } from '@/store/user';
import type { LobeAgentSettings } from '@/types/session';
import type { UserSettings } from '@/types/user/settings';
import { merge } from '@/utils/merge';

vi.mock('zustand/traditional');

// Mock userService
vi.mock('@/services/user', () => ({
  userService: {
    updateUserSettings: vi.fn(),
    resetUserSettings: vi.fn(),
  },
}));

describe('SettingsAction', () => {
  describe('importAppSettings', () => {
    it('should import app settings', async () => {
      const { result } = renderHook(() => useUserStore());
      const newSettings: UserSettings = merge(DEFAULT_SETTINGS, {
        general: { themeMode: 'dark' },
      });

      // Mock the internal setSettings function call
      const setSettingsSpy = vi.spyOn(result.current, 'setSettings');

      // Perform the action
      await act(async () => {
        await result.current.importAppSettings(newSettings);
      });

      // Assert that setSettings was called with the correct settings
      expect(setSettingsSpy).toHaveBeenCalledWith(newSettings);

      // Assert that the state has been updated
      expect(userService.updateUserSettings).toHaveBeenCalledWith(
        { general: { themeMode: 'dark' } },
        expect.any(AbortSignal),
      );

      // Restore the spy
      setSettingsSpy.mockRestore();
    });
  });

  describe('resetSettings', () => {
    it('should reset settings to default', async () => {
      const { result } = renderHook(() => useUserStore());

      // Perform the action
      await act(async () => {
        await result.current.resetSettings();
      });

      // Assert that resetUserSettings was called
      expect(userService.resetUserSettings).toHaveBeenCalled();

      // Assert that the state has been updated to default settings
      expect(result.current.settings).toEqual({});
    });
  });

  describe('setSettings', () => {
    it('should set partial settings', async () => {
      const { result } = renderHook(() => useUserStore());
      const partialSettings: PartialDeep<UserSettings> = { general: { fontSize: 12 } };

      // Perform the action
      await act(async () => {
        await result.current.setSettings(partialSettings);
      });

      // Assert that updateUserSettings was called with the correct settings
      expect(userService.updateUserSettings).toHaveBeenCalledWith(
        partialSettings,
        expect.any(AbortSignal),
      );
    });

    it('should not resend an unchanged credential-bearing group with a general update', async () => {
      const { result } = renderHook(() => useUserStore());
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockResolvedValue(undefined);

      act(() => {
        useUserStore.setState({
          settings: {
            languageModel: {
              openai: { enabled: true },
            },
          },
        });
      });
      vi.mocked(userService.updateUserSettings).mockResolvedValueOnce({ appliedPaths: [] });

      await act(async () => {
        await useUserStore.getState().setSettings({ general: { responseLanguage: 'zh-CN' } });
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        { general: { responseLanguage: 'zh-CN' } },
        expect.any(AbortSignal),
      );
      refreshUserStateSpy.mockRestore();
    });

    it('should roll back a failed optimistic update so the same value can be retried', async () => {
      const { result } = renderHook(() => useUserStore());
      const partialSettings: PartialDeep<UserSettings> = {
        general: { responseLanguage: 'zh-CN' },
      };
      const failure = new Error('Failed to save settings');
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockResolvedValue(undefined);

      vi.mocked(userService.updateUserSettings)
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ appliedPaths: [] });

      let caughtError: unknown;
      await act(async () => {
        try {
          await result.current.setSettings(partialSettings);
        } catch (error) {
          caughtError = error;
        }
      });

      expect(caughtError).toBe(failure);
      expect(useUserStore.getState().settings.general?.responseLanguage).toBeUndefined();

      await act(async () => {
        await useUserStore.getState().setSettings(partialSettings);
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        partialSettings,
        expect.any(AbortSignal),
      );
      expect(refreshUserStateSpy).toHaveBeenCalledTimes(1);
      refreshUserStateSpy.mockRestore();
    });

    it('coalesces an aborted cross-group edit into the newest persisted request', async () => {
      const { result } = renderHook(() => useUserStore());
      const aborted = new Error('Request aborted');
      let serverSettings: PartialDeep<UserSettings> = {};
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockImplementation(async () => {
          useUserStore.setState({ settings: serverSettings });
        });

      vi.mocked(userService.updateUserSettings)
        .mockImplementationOnce(
          (_settings, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(aborted), { once: true });
            }),
        )
        .mockImplementationOnce(async (updates) => {
          serverSettings = merge(serverSettings, updates);
          return { appliedPaths: [] };
        });

      let olderRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        olderRequest = result.current
          .setSettings({ memory: { enabled: false } })
          .catch((error) => error);
      });

      await act(async () => {
        await useUserStore.getState().setSettings({ general: { responseLanguage: 'zh-CN' } });
      });

      expect(await olderRequest).toBe(aborted);
      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        {
          general: { responseLanguage: 'zh-CN' },
          memory: { enabled: false },
        },
        expect.any(AbortSignal),
      );
      expect(useUserStore.getState().settings).toMatchObject({
        general: { responseLanguage: 'zh-CN' },
        memory: { enabled: false },
      });
      refreshUserStateSpy.mockRestore();
    });

    it('ignores an obsolete successful response while a newer optimistic edit is pending', async () => {
      const { result } = renderHook(() => useUserStore());
      const aborted = new Error('Request aborted');
      let resolveMemoryRequest!: () => void;
      let serverSettings: PartialDeep<UserSettings> = {};
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockImplementation(async () => {
          useUserStore.setState({ settings: serverSettings });
        });

      vi.mocked(userService.updateUserSettings)
        // Deliberately ignore abort: some adapters can finish a commit after cancellation.
        .mockImplementationOnce(
          (updates) =>
            new Promise((resolve) => {
              resolveMemoryRequest = () => {
                serverSettings = merge(serverSettings, updates);
                resolve({ appliedPaths: [] });
              };
            }),
        )
        // Keep the superseding general-settings request pending until the third edit aborts it.
        .mockImplementationOnce(
          (_updates, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(aborted), { once: true });
            }),
        )
        .mockImplementationOnce(async (updates) => {
          serverSettings = merge(serverSettings, updates);
          return { appliedPaths: [] };
        });

      let memoryRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        memoryRequest = result.current
          .setSettings({ memory: { enabled: false } })
          .catch((error) => error);
      });

      let generalRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        generalRequest = useUserStore
          .getState()
          .setSettings({ general: { responseLanguage: 'zh-CN' } })
          .catch((error) => error);
      });

      await act(async () => {
        resolveMemoryRequest();
        await memoryRequest;
      });

      expect(refreshUserStateSpy).not.toHaveBeenCalled();
      expect(useUserStore.getState().settings).toMatchObject({
        general: { responseLanguage: 'zh-CN' },
        memory: { enabled: false },
      });

      await act(async () => {
        await useUserStore.getState().setSettings({
          tool: { humanIntervention: { approvalMode: 'manual' } },
        });
      });

      expect(await generalRequest).toBe(aborted);
      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        {
          general: { responseLanguage: 'zh-CN' },
          memory: { enabled: false },
          tool: { humanIntervention: { approvalMode: 'manual' } },
        },
        expect.any(AbortSignal),
      );
      expect(refreshUserStateSpy).toHaveBeenCalledTimes(1);
      expect(useUserStore.getState().settings).toMatchObject({
        general: { responseLanguage: 'zh-CN' },
        memory: { enabled: false },
        tool: { humanIntervention: { approvalMode: 'manual' } },
      });
      refreshUserStateSpy.mockRestore();
    });

    it('restores a newer optimistic edit overwritten by an in-flight stale refresh', async () => {
      const { result } = renderHook(() => useUserStore());
      const aborted = new Error('Request aborted');
      let resolveFirstRefresh!: () => void;
      let signalFirstRefreshStarted!: () => void;
      const firstRefreshStarted = new Promise<void>((resolve) => {
        signalFirstRefreshStarted = resolve;
      });
      let serverSettings: PartialDeep<UserSettings> = {};
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              const staleSnapshot = serverSettings;
              signalFirstRefreshStarted();
              resolveFirstRefresh = () => {
                useUserStore.setState({ settings: staleSnapshot });
                resolve();
              };
            }),
        )
        .mockImplementationOnce(async () => {
          useUserStore.setState({ settings: serverSettings });
        });

      vi.mocked(userService.updateUserSettings)
        .mockImplementationOnce(async (updates) => {
          serverSettings = merge(serverSettings, updates);
          return { appliedPaths: [] };
        })
        .mockImplementationOnce(
          (_updates, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(aborted), { once: true });
            }),
        )
        .mockImplementationOnce(async (updates) => {
          serverSettings = merge(serverSettings, updates);
          return { appliedPaths: [] };
        });

      let memoryRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        memoryRequest = result.current
          .setSettings({ memory: { enabled: false } })
          .catch((error) => error);
      });
      await act(async () => firstRefreshStarted);

      let generalRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        generalRequest = useUserStore
          .getState()
          .setSettings({ general: { responseLanguage: 'zh-CN' } })
          .catch((error) => error);
      });

      let toolRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        // Resolve the stale refresh and start a third edit in the same turn, before the older
        // setSettings continuation has a chance to restore the optimistic general group.
        resolveFirstRefresh();
        toolRequest = useUserStore
          .getState()
          .setSettings({
            tool: { humanIntervention: { approvalMode: 'manual' } },
          })
          .catch((error) => error);
      });

      await act(async () => {
        await Promise.all([memoryRequest, toolRequest]);
      });

      expect(await generalRequest).toBe(aborted);
      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        {
          general: { responseLanguage: 'zh-CN' },
          memory: { enabled: false },
          tool: { humanIntervention: { approvalMode: 'manual' } },
        },
        expect.any(AbortSignal),
      );
      expect(useUserStore.getState().settings).toMatchObject({
        general: { responseLanguage: 'zh-CN' },
        memory: { enabled: false },
        tool: { humanIntervention: { approvalMode: 'manual' } },
      });
      refreshUserStateSpy.mockRestore();
    });

    it('retains carried groups when the coalesced latest request fails', async () => {
      const { result } = renderHook(() => useUserStore());
      const aborted = new Error('Request aborted');
      const coalescedFailure = new Error('Coalesced request failed');
      let serverSettings: PartialDeep<UserSettings> = {};
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockImplementation(async () => {
          useUserStore.setState({ settings: serverSettings });
        });

      vi.mocked(userService.updateUserSettings)
        .mockImplementationOnce(
          (_settings, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(aborted), { once: true });
            }),
        )
        .mockRejectedValueOnce(coalescedFailure)
        .mockImplementationOnce(async (updates) => {
          serverSettings = merge(serverSettings, updates);
          return { appliedPaths: [] };
        });

      let memoryRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        memoryRequest = result.current
          .setSettings({ memory: { enabled: false } })
          .catch((error) => error);
      });

      let failedRequest: Promise<unknown> = Promise.resolve();
      await act(async () => {
        failedRequest = useUserStore
          .getState()
          .setSettings({ general: { responseLanguage: 'zh-CN' } })
          .catch((error) => error);
        await failedRequest;
      });

      expect(await memoryRequest).toBe(aborted);
      expect(await failedRequest).toBe(coalescedFailure);
      expect(useUserStore.getState().settings.memory?.enabled).toBe(false);
      expect(useUserStore.getState().settings.general?.responseLanguage).toBeUndefined();

      await act(async () => {
        await useUserStore.getState().setSettings({
          tool: { humanIntervention: { approvalMode: 'manual' } },
        });
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        {
          memory: { enabled: false },
          tool: { humanIntervention: { approvalMode: 'manual' } },
        },
        expect.any(AbortSignal),
      );
      expect(useUserStore.getState().settings).toMatchObject({
        memory: { enabled: false },
        tool: { humanIntervention: { approvalMode: 'manual' } },
      });
      refreshUserStateSpy.mockRestore();
    });

    it('clears retained pending groups when settings are reset', async () => {
      const { result } = renderHook(() => useUserStore());
      const aborted = new Error('Request aborted');
      const coalescedFailure = new Error('Coalesced request failed');
      let serverSettings: PartialDeep<UserSettings> = {};
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockImplementation(async () => {
          useUserStore.setState({ settings: serverSettings });
        });

      vi.mocked(userService.updateUserSettings)
        .mockImplementationOnce(
          (_settings, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(aborted), { once: true });
            }),
        )
        .mockRejectedValueOnce(coalescedFailure)
        .mockImplementationOnce(async (updates) => {
          serverSettings = merge(serverSettings, updates);
          return { appliedPaths: [] };
        });
      vi.mocked(userService.resetUserSettings).mockImplementationOnce(async () => {
        serverSettings = {};
      });

      let memoryRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        memoryRequest = result.current
          .setSettings({ memory: { enabled: false } })
          .catch((error) => error);
      });

      let failedRequest: Promise<unknown> = Promise.resolve();
      await act(async () => {
        failedRequest = useUserStore
          .getState()
          .setSettings({ general: { responseLanguage: 'zh-CN' } })
          .catch((error) => error);
        await failedRequest;
      });

      expect(await memoryRequest).toBe(aborted);
      expect(await failedRequest).toBe(coalescedFailure);
      expect(useUserStore.getState().settings.memory?.enabled).toBe(false);

      await act(async () => {
        await useUserStore.getState().resetSettings();
      });
      expect(useUserStore.getState().settings).toEqual({});

      await act(async () => {
        await useUserStore.getState().setSettings({
          tool: { humanIntervention: { approvalMode: 'manual' } },
        });
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        { tool: { humanIntervention: { approvalMode: 'manual' } } },
        expect.any(AbortSignal),
      );
      expect(useUserStore.getState().settings.memory).toBeUndefined();
      refreshUserStateSpy.mockRestore();
    });

    it('queues a post-reset edit until a delayed server reset completes', async () => {
      const { result } = renderHook(() => useUserStore());
      let resolveReset!: () => void;
      let serverSettings: PartialDeep<UserSettings> = {
        memory: { enabled: false },
      };
      act(() => {
        useUserStore.setState({ settings: serverSettings });
      });
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockImplementation(async () => {
          useUserStore.setState({ settings: serverSettings });
        });
      vi.mocked(userService.resetUserSettings).mockImplementationOnce(
        () =>
          new Promise<Awaited<ReturnType<typeof userService.resetUserSettings>>>((resolve) => {
            resolveReset = () => {
              serverSettings = {};
              resolve(undefined);
            };
          }),
      );
      vi.mocked(userService.updateUserSettings).mockImplementationOnce(async (updates) => {
        serverSettings = merge(serverSettings, updates);
        return { appliedPaths: [] };
      });
      const updateCallCountBeforeReset = vi.mocked(userService.updateUserSettings).mock.calls
        .length;

      let resetRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        resetRequest = result.current.resetSettings();
      });
      let toolRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        toolRequest = useUserStore.getState().setSettings({
          tool: { humanIntervention: { approvalMode: 'manual' } },
        });
      });

      expect(userService.updateUserSettings).toHaveBeenCalledTimes(updateCallCountBeforeReset);

      await act(async () => {
        resolveReset();
        await Promise.all([resetRequest, toolRequest]);
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        { tool: { humanIntervention: { approvalMode: 'manual' } } },
        expect.any(AbortSignal),
      );
      expect(serverSettings).toEqual({
        tool: { humanIntervention: { approvalMode: 'manual' } },
      });
      expect(useUserStore.getState().settings).toEqual(serverSettings);
      refreshUserStateSpy.mockRestore();
    });

    it('persists a queued post-reset edit when the reset freshness refresh fails', async () => {
      const { result } = renderHook(() => useUserStore());
      const refreshFailure = new Error('Reset refresh failed');
      let resolveReset!: () => void;
      let serverSettings: PartialDeep<UserSettings> = {
        memory: { enabled: false },
      };
      act(() => {
        useUserStore.setState({ settings: serverSettings });
      });
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockRejectedValueOnce(refreshFailure)
        .mockImplementationOnce(async () => {
          useUserStore.setState({ settings: serverSettings });
        });
      vi.mocked(userService.resetUserSettings).mockImplementationOnce(
        () =>
          new Promise<Awaited<ReturnType<typeof userService.resetUserSettings>>>((resolve) => {
            resolveReset = () => {
              serverSettings = {};
              resolve(undefined);
            };
          }),
      );
      vi.mocked(userService.updateUserSettings).mockImplementationOnce(async (updates) => {
        serverSettings = merge(serverSettings, updates);
        return { appliedPaths: [] };
      });
      const updateCallCountBeforeReset = vi.mocked(userService.updateUserSettings).mock.calls
        .length;

      let resetRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        resetRequest = result.current.resetSettings().catch((error) => error);
      });
      let toolRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        toolRequest = useUserStore.getState().setSettings({
          tool: { humanIntervention: { approvalMode: 'manual' } },
        });
      });
      expect(userService.updateUserSettings).toHaveBeenCalledTimes(updateCallCountBeforeReset);

      await act(async () => {
        resolveReset();
        await Promise.all([resetRequest, toolRequest]);
      });

      expect(await resetRequest).toBe(refreshFailure);
      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        { tool: { humanIntervention: { approvalMode: 'manual' } } },
        expect.any(AbortSignal),
      );
      expect(serverSettings).toEqual({
        tool: { humanIntervention: { approvalMode: 'manual' } },
      });
      expect(useUserStore.getState().settings).toEqual(serverSettings);
      refreshUserStateSpy.mockRestore();
    });

    it('reconciles server state and surfaces a failed reset after clearing an old pending edit', async () => {
      const { result } = renderHook(() => useUserStore());
      const aborted = new Error('Request aborted');
      const coalescedFailure = new Error('Coalesced request failed');
      const resetFailure = new Error('Reset failed');
      let serverSettings: PartialDeep<UserSettings> = {
        memory: { enabled: true },
      };
      act(() => {
        useUserStore.setState({ settings: serverSettings });
      });
      const refreshUserStateSpy = vi
        .spyOn(result.current, 'refreshUserState')
        .mockImplementation(async () => {
          useUserStore.setState({ settings: serverSettings });
        });
      vi.mocked(userService.updateUserSettings)
        .mockImplementationOnce(
          (_settings, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(aborted), { once: true });
            }),
        )
        .mockRejectedValueOnce(coalescedFailure)
        .mockImplementationOnce(async (updates) => {
          serverSettings = merge(serverSettings, updates);
          return { appliedPaths: [] };
        });
      vi.mocked(userService.resetUserSettings).mockRejectedValueOnce(resetFailure);

      let memoryRequest: Promise<unknown> = Promise.resolve();
      act(() => {
        memoryRequest = result.current
          .setSettings({ memory: { enabled: false } })
          .catch((error) => error);
      });
      let failedRequest: Promise<unknown> = Promise.resolve();
      await act(async () => {
        failedRequest = useUserStore
          .getState()
          .setSettings({ general: { responseLanguage: 'zh-CN' } })
          .catch((error) => error);
        await failedRequest;
      });
      expect(await memoryRequest).toBe(aborted);
      expect(await failedRequest).toBe(coalescedFailure);
      expect(useUserStore.getState().settings.memory?.enabled).toBe(false);

      let caughtResetError: unknown;
      await act(async () => {
        try {
          await useUserStore.getState().resetSettings();
        } catch (error) {
          caughtResetError = error;
        }
      });

      expect(caughtResetError).toBe(resetFailure);
      expect(useUserStore.getState().settings).toEqual(serverSettings);

      await act(async () => {
        await useUserStore.getState().setSettings({
          tool: { humanIntervention: { approvalMode: 'manual' } },
        });
      });
      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        { tool: { humanIntervention: { approvalMode: 'manual' } } },
        expect.any(AbortSignal),
      );
      expect(useUserStore.getState().settings).toEqual(serverSettings);
      refreshUserStateSpy.mockRestore();
    });

    it('should include field in diffs when user resets it to default value', async () => {
      const { result } = renderHook(() => useUserStore());

      // First, set memory.enabled to false (non-default value)
      await act(async () => {
        await result.current.setSettings({ memory: { enabled: false } });
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ memory: { enabled: false } }),
        expect.any(AbortSignal),
      );

      // Then, reset memory.enabled back to true (default value)
      // This should still include memory in the diffs to override the previously saved value
      await act(async () => {
        await result.current.setSettings({ memory: { enabled: true } });
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({ memory: { enabled: true } }),
        expect.any(AbortSignal),
      );
    });

    it('should keep legacy scalar system agent fields unchanged', async () => {
      const { result } = renderHook(() => useUserStore());
      const settingsWithLegacySystemAgent = {
        systemAgent: {
          enableAutoReply: true,
        },
      } as PartialDeep<UserSettings>;

      await act(async () => {
        await result.current.setSettings(settingsWithLegacySystemAgent);
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        settingsWithLegacySystemAgent,
        expect.any(AbortSignal),
      );
    });
  });

  describe('updateDefaultAgent', () => {
    it('should update default agent settings', async () => {
      const { result } = renderHook(() => useUserStore());
      const updatedAgent: Partial<LobeAgentSettings> = {
        meta: { title: 'docs' },
      };

      // Perform the action
      await act(async () => {
        await result.current.updateDefaultAgent(updatedAgent);
      });

      // Assert that updateUserSettings was called with the merged agent settings
      expect(userService.updateUserSettings).toHaveBeenCalledWith(
        { defaultAgent: updatedAgent },
        expect.any(AbortSignal),
      );
    });

    it('should persist default agent model and provider together', async () => {
      const { result } = renderHook(() => useUserStore());

      await act(async () => {
        await result.current.updateDefaultAgent({
          config: { model: 'claude-opus-4-6' },
        });
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        {
          defaultAgent: {
            config: {
              model: 'claude-opus-4-6',
              provider: DEFAULT_SETTINGS.defaultAgent.config.provider,
            },
          },
        },
        expect.any(AbortSignal),
      );
    });
  });

  describe('updateSystemAgent', () => {
    it('should set partial settings', async () => {
      const { result } = renderHook(() => useUserStore());
      const systemAgentSettings: PartialDeep<UserSettings> = {
        systemAgent: {
          translation: {
            model: 'testmodel',
            provider: 'provider',
          },
        },
      };

      // Perform the action
      await act(async () => {
        await result.current.updateSystemAgent('translation', {
          provider: 'provider',
          model: 'testmodel',
        });
      });

      // Assert that updateUserSettings was called with the correct settings
      expect(userService.updateUserSettings).toHaveBeenCalledWith(
        systemAgentSettings,
        expect.any(AbortSignal),
      );
    });

    it('should persist system agent model and provider together when provider matches default', async () => {
      const { result } = renderHook(() => useUserStore());
      const model = 'ag/gemini-3.1-pro-high';
      const provider = DEFAULT_SETTINGS.systemAgent.translation.provider;

      await act(async () => {
        await result.current.updateSystemAgent('translation', { model, provider });
      });

      expect(userService.updateUserSettings).toHaveBeenLastCalledWith(
        {
          systemAgent: {
            translation: {
              model,
              provider,
            },
          },
        },
        expect.any(AbortSignal),
      );
    });
  });
});
