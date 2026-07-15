import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';

import { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from '../services/platform';
import EnterprisePlatformProvider, { useEnterprisePlatform } from './EnterprisePlatformProvider';

const serverConfigState = vi.hoisted(() => ({
  enterpriseEnabled: false,
  serverConfigInit: true,
}));

vi.mock('@/store/serverConfig', () => ({
  useServerConfigStore: (selector: (s: any) => unknown) =>
    selector({
      serverConfig: {
        enterprise: { enabled: serverConfigState.enterpriseEnabled },
      },
      serverConfigInit: serverConfigState.serverConfigInit,
    }),
}));

vi.mock('../services/platform', () => ({
  fetchPlatformCapabilities: vi.fn(async () => DISABLED_PLATFORM_CAPABILITIES),
  fetchPlatformPublicSnapshot: vi.fn(async () => ({
    brandingRevision: null,
    configRevision: '0',
    login: { workAccountEnabled: false },
    logoUrl: null,
    platformName: null,
  })),
}));

const Probe = () => {
  const { capabilities, loading } = useEnterprisePlatform();
  return (
    <div>
      <span data-testid="admin">{String(capabilities.adminAccess)}</span>
      <span data-testid="loading">{String(loading)}</span>
      <span>child</span>
    </div>
  );
};

describe('EnterprisePlatformProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverConfigState.enterpriseEnabled = false;
    serverConfigState.serverConfigInit = true;
  });

  it('renders children and starts from disabled capabilities', () => {
    render(
      <EnterprisePlatformProvider disableFetch>
        <Probe />
      </EnterprisePlatformProvider>,
    );
    expect(screen.getByText('child')).toBeTruthy();
    expect(screen.getByTestId('admin').textContent).toBe('false');
  });

  it('flags off: zero platform.* fetch calls after global config hydrates', async () => {
    serverConfigState.enterpriseEnabled = false;
    serverConfigState.serverConfigInit = true;

    render(
      <EnterprisePlatformProvider>
        <Probe />
      </EnterprisePlatformProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('admin').textContent).toBe('false');
    });

    expect(fetchPlatformCapabilities).not.toHaveBeenCalled();
    expect(fetchPlatformPublicSnapshot).not.toHaveBeenCalled();
  });

  it('enterprise enabled: loads platform snapshots once config is ready', async () => {
    serverConfigState.enterpriseEnabled = true;
    serverConfigState.serverConfigInit = true;

    render(
      <EnterprisePlatformProvider>
        <Probe />
      </EnterprisePlatformProvider>,
    );

    await waitFor(() => {
      expect(fetchPlatformCapabilities).toHaveBeenCalledTimes(1);
      expect(fetchPlatformPublicSnapshot).toHaveBeenCalledTimes(1);
    });
  });
});
