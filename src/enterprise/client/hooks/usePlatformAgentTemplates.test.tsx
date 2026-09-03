/**
 * @vitest-environment happy-dom
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const useClientDataSWRMock = vi.fn();

vi.mock('@/enterprise/client/services/platform', () => ({
  fetchPlatformAgentTemplates: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (...args: unknown[]) => useClientDataSWRMock(...args),
}));

const i18nState = { language: 'en', resolvedLanguage: 'en-US' as string | undefined };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: i18nState }),
}));

const serverConfigState = {
  platformAdmin: false as boolean,
  serverConfigInit: true,
};

type ServerConfigStoreSlice = {
  serverConfig: { enterprise: { enabled: boolean; platformAdmin: boolean } };
  serverConfigInit: boolean;
};

vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (s: ServerConfigStoreSlice) => unknown) =>
    selector({
      serverConfig: {
        enterprise: {
          enabled: serverConfigState.platformAdmin,
          platformAdmin: serverConfigState.platformAdmin,
        },
      },
      serverConfigInit: serverConfigState.serverConfigInit,
    }),
}));

describe('usePlatformAgentTemplates', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    useClientDataSWRMock.mockReset();
    useClientDataSWRMock.mockReturnValue({ data: undefined });
    serverConfigState.platformAdmin = false;
    serverConfigState.serverConfigInit = true;
    i18nState.language = 'en';
    i18nState.resolvedLanguage = 'en-US';
  });

  it('flag off: zero RPCs, resolved immediately, locale examples stay in charge', async () => {
    const { usePlatformAgentTemplates } = await import('./usePlatformAgentTemplates');
    const { result } = renderHook(() => usePlatformAgentTemplates());

    expect(result.current).toEqual({ managed: false, resolved: true, templates: [] });
    const [key] = useClientDataSWRMock.mock.calls[0];
    expect(key).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays unresolved until the server config hydrates (the flag is not known yet)', async () => {
    serverConfigState.serverConfigInit = false;

    const { usePlatformAgentTemplates } = await import('./usePlatformAgentTemplates');
    const { result } = renderHook(() => usePlatformAgentTemplates());

    // Reporting `resolved: true` here would let the locale examples start before the
    // platform-admin flag is known.
    expect(result.current).toEqual({ managed: false, resolved: false, templates: [] });
    expect(useClientDataSWRMock.mock.calls[0][0]).toBeNull();
  });

  it('flag on: keys the fetch and reports the managed list', async () => {
    serverConfigState.platformAdmin = true;
    const templates = [{ identifier: 'agent-01', title: 'Writer' }];
    useClientDataSWRMock.mockReturnValue({ data: { managed: true, templates } });

    const { PLATFORM_AGENT_TEMPLATES_KEY, usePlatformAgentTemplates } =
      await import('./usePlatformAgentTemplates');
    const { result } = renderHook(() => usePlatformAgentTemplates());

    expect(useClientDataSWRMock.mock.calls[0][0]).toEqual([PLATFORM_AGENT_TEMPLATES_KEY, 'en-US']);
    expect(result.current).toEqual({ managed: true, resolved: true, templates });
  });

  it('forwards the UI locale to the fetch so a first-run auto-seed uses the user language', async () => {
    serverConfigState.platformAdmin = true;
    i18nState.resolvedLanguage = 'zh-CN';

    const { usePlatformAgentTemplates } = await import('./usePlatformAgentTemplates');
    renderHook(() => usePlatformAgentTemplates());

    const [, fetcher] = useClientDataSWRMock.mock.calls[0];
    await (fetcher as () => Promise<unknown>)();
    expect(fetchMock).toHaveBeenCalledWith('zh-CN');
  });

  it('falls back to i18n.language when no resolved language is available', async () => {
    serverConfigState.platformAdmin = true;
    i18nState.language = 'zh-CN';
    i18nState.resolvedLanguage = undefined;

    const { PLATFORM_AGENT_TEMPLATES_KEY, usePlatformAgentTemplates } =
      await import('./usePlatformAgentTemplates');
    renderHook(() => usePlatformAgentTemplates());

    expect(useClientDataSWRMock.mock.calls[0][0]).toEqual([PLATFORM_AGENT_TEMPLATES_KEY, 'zh-CN']);
  });

  it('re-keys when the language changes so an English cache is not reused', async () => {
    serverConfigState.platformAdmin = true;

    const { PLATFORM_AGENT_TEMPLATES_KEY, usePlatformAgentTemplates } =
      await import('./usePlatformAgentTemplates');
    const { rerender } = renderHook(() => usePlatformAgentTemplates());

    i18nState.resolvedLanguage = 'zh-CN';
    rerender();

    const keys = useClientDataSWRMock.mock.calls.map(([key]) => key);
    expect(keys).toContainEqual([PLATFORM_AGENT_TEMPLATES_KEY, 'en-US']);
    expect(keys).toContainEqual([PLATFORM_AGENT_TEMPLATES_KEY, 'zh-CN']);
  });

  it('stays unresolved while the first read is in flight', async () => {
    serverConfigState.platformAdmin = true;
    useClientDataSWRMock.mockReturnValue({ data: undefined, isLoading: true });

    const { usePlatformAgentTemplates } = await import('./usePlatformAgentTemplates');
    const { result } = renderHook(() => usePlatformAgentTemplates());

    expect(result.current).toEqual({ managed: false, resolved: false, templates: [] });
  });

  it('fails open to the locale examples when the read errors', async () => {
    serverConfigState.platformAdmin = true;
    useClientDataSWRMock.mockReturnValue({ error: new Error('boom') });

    const { usePlatformAgentTemplates } = await import('./usePlatformAgentTemplates');
    const { result } = renderHook(() => usePlatformAgentTemplates());

    expect(result.current).toEqual({ managed: false, resolved: true, templates: [] });
  });
});
