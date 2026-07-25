// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectorListPage, { CONNECTOR_SEARCH_DEBOUNCE_MS } from './ConnectorListPage';

const mocks = vi.hoisted(() => ({
  setSearchParams: vi.fn(),
  useFetchAdminConnectors: vi.fn((_opts?: { query?: string }) => ({
    data: { items: [], nextCursor: null },
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  })),
  searchParams: new URLSearchParams(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Select: () => null,
  toast: { success: vi.fn() },
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: any) => <div>{children}</div>,
  Input: ({ value, onChange, 'aria-label': ariaLabel, ...props }: any) => (
    <input aria-label={ariaLabel} value={value ?? ''} onChange={onChange} {...props} />
  ),
  Tag: ({ children }: any) => <span>{children}</span>,
  Text: ({ children }: any) => <span>{children}</span>,
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: null,
    permissions: [
      'platform_connector:read:all',
      'platform_connector:create:all',
      'platform_connector:update:all',
    ],
  }),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useSearchParams: () => [mocks.searchParams, mocks.setSearchParams],
  };
});

vi.mock('./useAdminConnectorCatalog', () => ({
  refreshAdminConnectorLists: vi.fn(),
  useFetchAdminConnectors: mocks.useFetchAdminConnectors,
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: { createDraft: vi.fn() },
}));

vi.mock('./openCreateConnectorModal', () => ({
  openCreateConnectorModal: vi.fn(),
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ children, toolbar }: any) => (
    <div>
      {toolbar}
      {children}
    </div>
  ),
}));

vi.mock('../primitives/DataTable', () => ({
  default: () => <div data-testid="data-table" />,
}));

vi.mock('../primitives/StatusBadge', () => ({
  default: () => null,
}));

describe('ConnectorListPage search debounce', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.searchParams = new URLSearchParams();
    mocks.useFetchAdminConnectors.mockReturnValue({
      data: { items: [], nextCursor: null },
      error: undefined,
      isLoading: false,
      mutate: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits one URL update after rapid typing and resets pagination once', async () => {
    render(
      <MemoryRouter>
        <ConnectorListPage />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText('connectorCatalog.filters.query');

    // Simulate rapid keystrokes without awaiting per-character timers.
    for (const char of 'oauth-prod') {
      fireEvent.change(input, { target: { value: `${(input as HTMLInputElement).value}${char}` } });
    }

    expect(mocks.setSearchParams).not.toHaveBeenCalled();
    expect(mocks.useFetchAdminConnectors.mock.calls.at(-1)?.[0]).toMatchObject({
      query: undefined,
    });

    await act(async () => {
      vi.advanceTimersByTime(CONNECTOR_SEARCH_DEBOUNCE_MS);
    });

    expect(mocks.setSearchParams).toHaveBeenCalledTimes(1);
    const nextParams = mocks.setSearchParams.mock.calls[0][0] as URLSearchParams;
    expect(nextParams.get('q')).toBe('oauth-prod');
  });
});
