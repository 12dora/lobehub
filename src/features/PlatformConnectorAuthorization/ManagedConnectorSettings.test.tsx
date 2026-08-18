import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ManagedConnectorSettings from './ManagedConnectorSettings';

const useManagedResource = vi.fn();

vi.mock('@/features/ManagedResources', () => ({
  ManagedResourceTransition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useManagedResource: (...args: unknown[]) => useManagedResource(...args),
}));

vi.mock('./PlatformConnectorAuthorization', () => ({
  default: () => <div data-testid="platform-connectors" />,
}));

/**
 * The platform-managed connector page is a document-flow list, not the
 * master-detail catalog the unmanaged fallback renders, so it needs its own
 * scroller — the settings pane around it is `overflow: hidden`.
 */
describe('ManagedConnectorSettings', () => {
  it('renders the managed authorization list inside a scroller', () => {
    useManagedResource.mockReturnValue({
      error: undefined,
      loading: false,
      managed: true,
      refresh: vi.fn(),
    });

    const { container } = render(<ManagedConnectorSettings fallback={null} />);

    const list = container.querySelector('[data-testid="platform-connectors"]')!;
    const scroller = list.closest('[style*="overflow-y: auto"]') as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.style.minHeight).toBe('0');
  });

  it('leaves the unmanaged catalog fallback full-bleed', () => {
    useManagedResource.mockReturnValue({
      error: undefined,
      loading: false,
      managed: false,
      refresh: vi.fn(),
    });

    const { container } = render(
      <ManagedConnectorSettings fallback={<div data-testid="tool-settings" />} />,
    );

    const fallback = container.querySelector('[data-testid="tool-settings"]')!;
    expect(fallback.closest('[style*="overflow-y: auto"]')).toBeNull();
  });
});
