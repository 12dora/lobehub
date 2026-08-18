import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSyncUpstreamModels } from './useSyncUpstreamModels';

const mocks = vi.hoisted(() => ({
  message: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  permission: { allowed: true, reason: 'no permission to manage provider keys' },
  takeover: { takeover: false, takeoverKnown: true },
  store: {
    supportsUpstreamSync: false,
    syncUpstreamModelList: vi.fn(),
  },
}));

vi.mock('antd', () => ({ App: { useApp: () => ({ message: mocks.message }) } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}|${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/usePermission', () => ({ usePermission: () => mocks.permission }));

vi.mock('@/features/ManagedResources/useManagedResource', () => ({
  usePlatformAiTakeover: () => mocks.takeover,
}));

vi.mock('@/store/aiInfra', () => ({
  useScopedAiInfraStore: (selector: (s: unknown) => unknown) => selector(mocks.store),
}));

const KEY = 'providerModels.list.syncUpstream';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission = { allowed: true, reason: 'no permission to manage provider keys' };
  mocks.takeover = { takeover: false, takeoverKnown: true };
  mocks.store.supportsUpstreamSync = false;
  mocks.store.syncUpstreamModelList = vi
    .fn()
    .mockResolvedValue({ created: 3, total: 14, updated: 11 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('useSyncUpstreamModels', () => {
  describe('member panel, platform takeover off', () => {
    it('is offered and dispatches the sync', async () => {
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      expect(result.current.disabled).toBe(false);
      expect(result.current.disabledReason).toBeUndefined();

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.store.syncUpstreamModelList).toHaveBeenCalledWith('cursor');
    });

    it('reports what actually changed', async () => {
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.message.success).toHaveBeenCalledWith(
        `${KEY}.success|${JSON.stringify({ created: 3, total: 14 })}`,
      );
    });

    it('reports an upstream that enumerated nothing as an outcome, not a failure', async () => {
      mocks.store.syncUpstreamModelList = vi
        .fn()
        .mockResolvedValue({ created: 0, total: 0, updated: 0 });
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.message.info).toHaveBeenCalledWith(`${KEY}.empty`);
      expect(mocks.message.success).not.toHaveBeenCalled();
    });
  });

  describe('member panel, platform takeover on', () => {
    it('does not fire a live sync and explains who owns the catalog', async () => {
      mocks.takeover = { takeover: true, takeoverKnown: true };
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      expect(result.current.disabled).toBe(true);
      expect(result.current.disabledReason).toBe(`${KEY}.managed`);

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.store.syncUpstreamModelList).not.toHaveBeenCalled();
    });

    // `usePlatformAiTakeover` collapses "loading" and "capability fetch failed" into
    // takeoverKnown: false — either way the member's catalog ownership is unproven.
    it('treats an unknown takeover state as managed', async () => {
      mocks.takeover = { takeover: false, takeoverKnown: false };
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      expect(result.current.disabled).toBe(true);
      expect(result.current.disabledReason).toBe(`${KEY}.managed`);

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.store.syncUpstreamModelList).not.toHaveBeenCalled();
    });
  });

  describe('admin panel', () => {
    it('stays available under takeover — it administers the platform credential itself', async () => {
      mocks.store.supportsUpstreamSync = true;
      mocks.takeover = { takeover: true, takeoverKnown: true };
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      expect(result.current.disabled).toBe(false);
      expect(result.current.disabledReason).toBeUndefined();

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.store.syncUpstreamModelList).toHaveBeenCalledWith('cursor');
    });

    it('reports an admin sync failure exactly once, and never as a raw code', async () => {
      mocks.store.supportsUpstreamSync = true;
      mocks.store.syncUpstreamModelList = vi.fn().mockRejectedValue(
        Object.assign(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'), {
          data: {
            errorData: {
              code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
              details: { issueCount: 2 },
              message: 'PLATFORM_CONFIG_VALIDATION_FAILED',
            },
          },
        }),
      );
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.message.error).toHaveBeenCalledTimes(1);
      expect(mocks.message.error).toHaveBeenCalledWith(
        `${KEY}.error|${JSON.stringify({ message: `${KEY}.validationFailed` })}`,
      );
      // The enterprise code is the server's own vocabulary; an operator must never read it.
      expect(String(mocks.message.error.mock.calls[0]![0])).not.toContain(
        'PLATFORM_CONFIG_VALIDATION_FAILED',
      );
    });
  });

  describe('permission gate', () => {
    it('disables the action with the permission reason', async () => {
      mocks.permission = { allowed: false, reason: 'no permission to manage provider keys' };
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      expect(result.current.disabled).toBe(true);
      expect(result.current.disabledReason).toBe('no permission to manage provider keys');

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.store.syncUpstreamModelList).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    // The server classifies the failure and answers with a stable code; the toast turns that
    // code into the SAME sentence the connectivity checker shows for it.
    it('names the cause the operator can act on', async () => {
      mocks.store.supportsUpstreamSync = true;
      mocks.store.syncUpstreamModelList = vi.fn().mockRejectedValue(
        Object.assign(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'), {
          data: {
            errorData: {
              code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
              details: { errorCategory: 'invalid_config' },
              message: 'connection_failed_transport',
            },
          },
        }),
      );
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.message.error).toHaveBeenCalledWith(
        `${KEY}.error|${JSON.stringify({
          message: 'llm.checker.reason.connectionFailedTransport',
        })}`,
      );
    });

    it('sends a dead shared grant to the reconnect copy, by runtime error type', async () => {
      mocks.store.supportsUpstreamSync = true;
      mocks.store.syncUpstreamModelList = vi.fn().mockRejectedValue(
        Object.assign(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'), {
          data: {
            errorData: {
              code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
              details: { errorCategory: 'auth', errorType: 'OAuthAuthorizationExpired' },
              message: 'connection_failed_shared_account_expired',
            },
          },
        }),
      );
      const { result } = renderHook(() => useSyncUpstreamModels('supergrok'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.message.error).toHaveBeenCalledWith(
        `${KEY}.error|${JSON.stringify({ message: 'llm.checker.reason.sharedAccountExpired' })}`,
      );
    });

    // Nothing has been connected yet: there is no failure to explain, only the step that was
    // skipped — and it is on the same page.
    it('points at the connect action when no shared account is stored', async () => {
      mocks.store.supportsUpstreamSync = true;
      mocks.store.syncUpstreamModelList = vi.fn().mockRejectedValue(
        Object.assign(new Error('PLATFORM_CONFIG_VALIDATION_FAILED'), {
          data: {
            errorData: {
              code: 'PLATFORM_CONFIG_VALIDATION_FAILED',
              details: { issueCount: 1, reason: 'shared_account_not_connected' },
              message: 'PLATFORM_CONFIG_VALIDATION_FAILED',
            },
          },
        }),
      );
      const { result } = renderHook(() => useSyncUpstreamModels('supergrok'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.message.error).toHaveBeenCalledWith(`${KEY}.sharedAccountNotConnected`);
    });

    // A plain rejection carries no body at all — the generic localized fallback, never the
    // exception text.
    it('falls back to localized copy for an error with no server body', async () => {
      mocks.store.syncUpstreamModelList = vi
        .fn()
        .mockRejectedValue(new Error('Cursor Agent transport unavailable'));
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.message.error).toHaveBeenCalledWith(
        `${KEY}.error|${JSON.stringify({
          message: 'providerModels.list.fetcher.errorFallback',
        })}`,
      );
    });

    // The server flags this on the error body; by status it is just another failed mutation.
    it('distinguishes a provider that cannot enumerate at all', async () => {
      mocks.store.supportsUpstreamSync = true;
      mocks.store.syncUpstreamModelList = vi.fn().mockRejectedValue(
        Object.assign(new Error('PLATFORM_INVALID_INPUT'), {
          data: { errorData: { details: { reason: 'cannot_enumerate' } } },
        }),
      );
      const { result } = renderHook(() => useSyncUpstreamModels('chatgpt'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(mocks.message.error).toHaveBeenCalledWith(`${KEY}.unsupported`);
    });

    it('clears the in-flight state so the action stays retryable', async () => {
      mocks.store.syncUpstreamModelList = vi.fn().mockRejectedValue(new Error('boom'));
      const { result } = renderHook(() => useSyncUpstreamModels('cursor'));

      await act(async () => {
        await result.current.syncUpstream();
      });

      expect(result.current.isSyncing).toBe(false);
    });
  });
});
