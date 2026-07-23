import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ZodModule from 'zod';

import DefaultInboxBrandingSync from '@/business/client/DefaultInboxBrandingSync';
import { initServerConfigStore, Provider } from '@/store/serverConfig/store';
import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';
import type { PlatformPublicSnapshot } from '@/types/platform/publicSnapshot';

import EnterprisePlatformProvider, { useEnterprisePlatform } from './EnterprisePlatformProvider';
import { useBranding } from './RuntimeBrandingProvider';

vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof ZodModule>();
  return { ...actual, z: actual.z ?? actual.default };
});

const serverConfigState = vi.hoisted(() => ({
  enterpriseEnabled: false,
  serverConfigInit: true,
}));

const inboxSyncMocks = vi.hoisted(() => ({
  cacheScope: 'user-a:personal',
  isLogin: true,
  syncInboxProjectionScope: vi.fn(),
  useInitBuiltinAgent: vi.fn(),
}));

vi.mock('@/libs/swr/useCacheScope', () => ({
  useCacheScope: () => inboxSyncMocks.cacheScope,
}));

vi.mock('@/store/agent', () => ({
  useAgentStore: (
    selector: (state: {
      syncInboxProjectionScope: typeof inboxSyncMocks.syncInboxProjectionScope;
      useInitBuiltinAgent: typeof inboxSyncMocks.useInitBuiltinAgent;
    }) => unknown,
  ) =>
    selector({
      syncInboxProjectionScope: inboxSyncMocks.syncInboxProjectionScope,
      useInitBuiltinAgent: inboxSyncMocks.useInitBuiltinAgent,
    }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (state: { isLogin: boolean }) => unknown) =>
    selector({ isLogin: inboxSyncMocks.isLogin }),
}));

vi.mock('@/store/user/selectors', () => ({
  authSelectors: { isLogin: (state: { isLogin: boolean }) => state.isLogin },
}));

const platformSkillMocks = vi.hoisted(() => ({
  beginPlatformSkillCatalogRequest: vi.fn(),
  completePlatformSkillCatalogRequest: vi.fn(),
  configurePlatformSkillManagement: vi.fn(),
  failPlatformSkillCatalogRequest: vi.fn(),
  getPublishedCatalog: vi.fn(),
  state: {
    platformSkillCatalogInvalidationRevision: '0',
  },
}));

vi.mock('../services/platformSkills', () => ({
  platformSkillsService: { getPublishedCatalog: platformSkillMocks.getPublishedCatalog },
}));

vi.mock('@/store/tool', () => ({
  useToolStore: Object.assign(
    (selector: (state: typeof platformSkillMocks.state) => unknown) =>
      selector(platformSkillMocks.state),
    {
      getState: () => ({
        beginPlatformSkillCatalogRequest: platformSkillMocks.beginPlatformSkillCatalogRequest,
        completePlatformSkillCatalogRequest: platformSkillMocks.completePlatformSkillCatalogRequest,
        configurePlatformSkillManagement: platformSkillMocks.configurePlatformSkillManagement,
        failPlatformSkillCatalogRequest: platformSkillMocks.failPlatformSkillCatalogRequest,
      }),
    },
  ),
}));

const fetchCapabilities = vi.fn(async () => DISABLED_PLATFORM_CAPABILITIES);
const fetchPublicSnapshot = vi.fn(async (): Promise<PlatformPublicSnapshot> => ({
  branding: null,
  brandingRevision: null,
  configRevision: '0',
  login: { openRegistration: true, workAccountEnabled: false },
  logoUrl: null,
  platformName: null,
}));

const Probe = () => {
  const { capabilities, error, loading, refresh } = useEnterprisePlatform();
  const branding = useBranding();
  return (
    <div>
      <span data-testid="admin">{String(capabilities.adminAccess)}</span>
      <span data-testid="agents-managed">{String(capabilities.managedResources.agents)}</span>
      <span data-testid="error">{error?.message ?? ''}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="brand-name">{branding.name}</span>
      <span data-testid="brand-revision">{branding.publishedRevision ?? 'built-in'}</span>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
      <span>child</span>
    </div>
  );
};

const renderProvider = (disableFetch = false, initialPublicSnapshot?: PlatformPublicSnapshot) =>
  render(
    <Provider
      createStore={() =>
        initServerConfigStore({
          serverConfig: {
            aiProvider: {},
            enterprise: { enabled: serverConfigState.enterpriseEnabled },
            telemetry: {},
          },
          serverConfigInit: serverConfigState.serverConfigInit,
        })
      }
    >
      <EnterprisePlatformProvider
        disableFetch={disableFetch}
        fetchCapabilities={fetchCapabilities}
        fetchPublicSnapshot={fetchPublicSnapshot}
        initialPublicSnapshot={initialPublicSnapshot}
      >
        <DefaultInboxBrandingSync />
        <Probe />
      </EnterprisePlatformProvider>
    </Provider>,
  );

describe('EnterprisePlatformProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    inboxSyncMocks.cacheScope = 'user-a:personal';
    inboxSyncMocks.isLogin = true;
    serverConfigState.enterpriseEnabled = false;
    serverConfigState.serverConfigInit = true;
    fetchCapabilities.mockReset().mockResolvedValue(DISABLED_PLATFORM_CAPABILITIES);
    platformSkillMocks.getPublishedCatalog.mockReset().mockResolvedValue({
      revision: 'catalog-1',
      skills: [],
    });
    platformSkillMocks.beginPlatformSkillCatalogRequest.mockReset().mockReturnValue(1);
    platformSkillMocks.completePlatformSkillCatalogRequest.mockReset();
    platformSkillMocks.configurePlatformSkillManagement.mockReset();
    platformSkillMocks.failPlatformSkillCatalogRequest.mockReset();
    fetchPublicSnapshot.mockReset().mockResolvedValue({
      branding: null,
      brandingRevision: null,
      configRevision: '0',
      login: { openRegistration: true, workAccountEnabled: false },
      logoUrl: null,
      platformName: null,
    });
  });

  it('renders children and starts from disabled capabilities', () => {
    renderProvider(true);
    expect(screen.getByText('child')).toBeTruthy();
    expect(screen.getByTestId('admin').textContent).toBe('false');
    expect(inboxSyncMocks.useInitBuiltinAgent).toHaveBeenCalledWith('inbox', {
      brandingRevision: null,
      cacheScope: 'user-a:personal',
      isLogin: true,
    });
    expect(inboxSyncMocks.syncInboxProjectionScope).toHaveBeenCalledWith('user-a:personal', true);
  });

  it('flags off: zero platform.* fetch calls after global config hydrates', async () => {
    serverConfigState.enterpriseEnabled = false;
    serverConfigState.serverConfigInit = true;

    renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('admin').textContent).toBe('false');
    });

    expect(fetchCapabilities).not.toHaveBeenCalled();
    expect(fetchPublicSnapshot).not.toHaveBeenCalled();
    expect(platformSkillMocks.getPublishedCatalog).not.toHaveBeenCalled();
    expect(platformSkillMocks.configurePlatformSkillManagement).toHaveBeenCalledWith(false);
  });

  it('enterprise enabled: loads platform snapshots once config is ready', async () => {
    serverConfigState.enterpriseEnabled = true;
    serverConfigState.serverConfigInit = true;

    renderProvider();

    await waitFor(() => {
      expect(fetchCapabilities).toHaveBeenCalledTimes(1);
      expect(fetchPublicSnapshot).toHaveBeenCalledTimes(1);
    });
    expect(platformSkillMocks.getPublishedCatalog).not.toHaveBeenCalled();
  });

  it('renders injected branding on the first paint and revalidates it in the background', async () => {
    serverConfigState.enterpriseEnabled = true;
    const initialPublicSnapshot: PlatformPublicSnapshot = {
      branding: {
        defaultAgentDisplayName: null,
        emailFrom: null,
        emailSenderName: null,
        faviconUrl: null,
        homeUrl: null,
        iconUrl: null,
        legalName: null,
        logoUrl: '/initial.png',
        name: 'Initial Brand',
        ogImageUrl: null,
        pageTitleTemplate: null,
        privacyUrl: null,
        revision: '3',
        shortName: null,
        supportUrl: null,
        termsUrl: null,
      },
      brandingRevision: '3',
      configRevision: 'config-3',
      login: { openRegistration: true, workAccountEnabled: false },
      logoUrl: '/initial.png',
      platformName: 'Initial Brand',
    };
    fetchPublicSnapshot.mockResolvedValue({
      ...initialPublicSnapshot,
      branding: { ...initialPublicSnapshot.branding!, name: 'Updated Brand', revision: '4' },
      brandingRevision: '4',
      configRevision: 'config-4',
      platformName: 'Updated Brand',
    });

    renderProvider(false, initialPublicSnapshot);

    expect(screen.getByTestId('brand-name')).toHaveTextContent('Initial Brand');
    expect(screen.getByTestId('brand-revision')).toHaveTextContent('3');
    await waitFor(() =>
      expect(screen.getByTestId('brand-name')).toHaveTextContent('Updated Brand'),
    );
    expect(screen.getByTestId('brand-revision')).toHaveTextContent('4');
    expect(fetchPublicSnapshot).toHaveBeenCalledOnce();
    expect(inboxSyncMocks.useInitBuiltinAgent).toHaveBeenCalledWith('inbox', {
      brandingRevision: '3',
      cacheScope: 'user-a:personal',
      isLogin: true,
    });
    expect(inboxSyncMocks.useInitBuiltinAgent).toHaveBeenCalledWith('inbox', {
      brandingRevision: '4',
      cacheScope: 'user-a:personal',
      isLogin: true,
    });
  });

  it('drives inbox synchronization across publish, rollback, and null revisions', async () => {
    serverConfigState.enterpriseEnabled = true;
    const snapshot = (revision: string | null, name: string): PlatformPublicSnapshot => ({
      branding:
        revision === null
          ? null
          : {
              defaultAgentDisplayName: null,
              emailFrom: null,
              emailSenderName: null,
              faviconUrl: null,
              homeUrl: null,
              iconUrl: null,
              legalName: null,
              logoUrl: null,
              name,
              ogImageUrl: null,
              pageTitleTemplate: null,
              privacyUrl: null,
              revision,
              shortName: null,
              supportUrl: null,
              termsUrl: null,
            },
      brandingRevision: revision,
      configRevision: revision ?? '0',
      login: { openRegistration: true, workAccountEnabled: false },
      logoUrl: null,
      platformName: revision === null ? null : name,
    });
    fetchPublicSnapshot
      .mockResolvedValueOnce(snapshot('B', 'Brand B'))
      .mockResolvedValueOnce(snapshot('A', 'Brand A'))
      .mockResolvedValueOnce(snapshot(null, 'LobeHub'));

    renderProvider(false, snapshot('A', 'Brand A'));
    await waitFor(() => expect(screen.getByTestId('brand-revision')).toHaveTextContent('B'));
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(screen.getByTestId('brand-revision')).toHaveTextContent('A'));
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(screen.getByTestId('brand-revision')).toHaveTextContent('built-in'));

    for (const revision of ['A', 'B', 'A', null]) {
      expect(inboxSyncMocks.useInitBuiltinAgent).toHaveBeenCalledWith('inbox', {
        brandingRevision: revision,
        cacheScope: 'user-a:personal',
        isLogin: true,
      });
    }
  });

  it('loads the single platform catalog authority in ui-only managed mode', async () => {
    serverConfigState.enterpriseEnabled = true;
    fetchCapabilities.mockResolvedValue({
      ...DISABLED_PLATFORM_CAPABILITIES,
      managedResources: { ...DISABLED_PLATFORM_CAPABILITIES.managedResources, skills: true },
    });

    renderProvider();

    await waitFor(() => expect(fetchCapabilities).toHaveBeenCalledOnce());
    await waitFor(() => expect(platformSkillMocks.getPublishedCatalog).toHaveBeenCalledOnce());
    expect(platformSkillMocks.configurePlatformSkillManagement).toHaveBeenLastCalledWith(true);
  });

  it('uses the same catalog path for every public managed Skill capability', async () => {
    serverConfigState.enterpriseEnabled = true;
    fetchCapabilities.mockResolvedValue({
      ...DISABLED_PLATFORM_CAPABILITIES,
      managedResources: { ...DISABLED_PLATFORM_CAPABILITIES.managedResources, skills: true },
    });

    renderProvider();

    await waitFor(() => expect(platformSkillMocks.getPublishedCatalog).toHaveBeenCalledOnce());
    expect(platformSkillMocks.configurePlatformSkillManagement).toHaveBeenLastCalledWith(true);
  });

  it('retains last-known capabilities with an error, then reactively refreshes after retry', async () => {
    serverConfigState.enterpriseEnabled = true;
    fetchCapabilities
      .mockResolvedValueOnce({
        ...DISABLED_PLATFORM_CAPABILITIES,
        managedResources: {
          ...DISABLED_PLATFORM_CAPABILITIES.managedResources,
          agents: true,
        },
      })
      .mockRejectedValueOnce(new Error('capabilities offline'))
      .mockResolvedValueOnce({
        ...DISABLED_PLATFORM_CAPABILITIES,
        managedResources: {
          ...DISABLED_PLATFORM_CAPABILITIES.managedResources,
          connectors: true,
        },
      });

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('agents-managed')).toHaveTextContent('true'));

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('capabilities offline'),
    );
    expect(screen.getByTestId('agents-managed')).toHaveTextContent('true');

    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => {
      expect(screen.getByTestId('error')).toHaveTextContent('');
      expect(screen.getByTestId('agents-managed')).toHaveTextContent('false');
    });
    expect(fetchCapabilities).toHaveBeenCalledTimes(3);
  });
});
