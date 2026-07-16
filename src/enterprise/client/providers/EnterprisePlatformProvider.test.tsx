import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ZodModule from 'zod';

import { initServerConfigStore, Provider } from '@/store/serverConfig/store';
import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';

import EnterprisePlatformProvider, { useEnterprisePlatform } from './EnterprisePlatformProvider';

vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof ZodModule>();
  return { ...actual, z: actual.z ?? actual.default };
});

const serverConfigState = vi.hoisted(() => ({
  enterpriseEnabled: false,
  serverConfigInit: true,
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
const fetchPublicSnapshot = vi.fn(async () => ({
  brandingRevision: null,
  configRevision: '0',
  login: { workAccountEnabled: false },
  logoUrl: null,
  platformName: null,
}));

const Probe = () => {
  const { capabilities, error, loading, refresh } = useEnterprisePlatform();
  return (
    <div>
      <span data-testid="admin">{String(capabilities.adminAccess)}</span>
      <span data-testid="agents-managed">{String(capabilities.managedResources.agents)}</span>
      <span data-testid="error">{error?.message ?? ''}</span>
      <span data-testid="loading">{String(loading)}</span>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
      <span>child</span>
    </div>
  );
};

const renderProvider = (disableFetch = false) =>
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
      >
        <Probe />
      </EnterprisePlatformProvider>
    </Provider>,
  );

describe('EnterprisePlatformProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      brandingRevision: null,
      configRevision: '0',
      login: { workAccountEnabled: false },
      logoUrl: null,
      platformName: null,
    });
  });

  it('renders children and starts from disabled capabilities', () => {
    renderProvider(true);
    expect(screen.getByText('child')).toBeTruthy();
    expect(screen.getByTestId('admin').textContent).toBe('false');
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
    expect(platformSkillMocks.configurePlatformSkillManagement).toHaveBeenCalledWith(false, false);
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

  it('configures management and loads the catalog only when managed Skills are effective', async () => {
    serverConfigState.enterpriseEnabled = true;
    fetchCapabilities.mockResolvedValue({
      ...DISABLED_PLATFORM_CAPABILITIES,
      managedResources: { ...DISABLED_PLATFORM_CAPABILITIES.managedResources, skills: true },
    });

    renderProvider();

    await waitFor(() => expect(platformSkillMocks.getPublishedCatalog).toHaveBeenCalledOnce());
    expect(platformSkillMocks.configurePlatformSkillManagement).toHaveBeenLastCalledWith(
      true,
      false,
    );
    expect(platformSkillMocks.completePlatformSkillCatalogRequest).toHaveBeenCalledWith(1, {
      revision: 'catalog-1',
      skills: [],
    });
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
