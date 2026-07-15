import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DISABLED_PLATFORM_CAPABILITIES } from '@/types/platform/capabilities';

import EnterprisePlatformProvider, { useEnterprisePlatform } from './EnterprisePlatformProvider';

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
  it('renders children and starts from disabled capabilities', () => {
    render(
      <EnterprisePlatformProvider disableFetch>
        <Probe />
      </EnterprisePlatformProvider>,
    );
    expect(screen.getByText('child')).toBeTruthy();
    expect(screen.getByTestId('admin').textContent).toBe('false');
  });
});
