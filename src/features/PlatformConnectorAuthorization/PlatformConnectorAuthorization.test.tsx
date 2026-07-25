/**
 * @vitest-environment happy-dom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PlatformConnectorAuthorization from './PlatformConnectorAuthorization';
import { buildManagedConnectorListKey } from './swrKeys';

const listManaged = vi.fn();
const mutate = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

// Stub base-ui Button — it needs MotionProvider the app sets up globally.
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={props.onClick}>
      {children}
    </button>
  ),
  Select: ({
    value,
    onChange,
    options,
  }: {
    onChange?: (value: number) => void;
    options?: Array<{ label: string; value: number }>;
    value?: number;
  }) => (
    <select
      aria-label="page-size"
      value={value}
      onChange={(event) => onChange?.(Number(event.target.value))}
    >
      {(options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('./useManagedConnectors', () => ({
  useFetchManagedConnectors: (input: { cursor?: string; limit: number; query?: string }) => {
    listManaged(input);
    return {
      data: {
        items: [
          {
            binding: null,
            credentialMode: 'none',
            description: null,
            displayName: input.query ? `Result for ${input.query}` : 'All connectors',
            id: 'connector-1',
            key: 'connector-1',
            publishedRevision: 1,
            tools: [],
          },
        ],
        nextCursor: null,
      },
      error: undefined,
      isLoading: false,
      mutate,
    };
  },
}));

vi.mock('./useConnectorAuthorizationActions', () => ({
  useConnectorAuthorizationActions: () => ({
    authorize: vi.fn(),
    busyAction: null,
    busyConnectorId: null,
    cancelAuthorization: vi.fn(),
    disconnect: vi.fn(),
    feedback: null,
  }),
}));

vi.mock('./ConnectorCard', () => ({
  default: ({ connector }: { connector: { displayName: string } }) => (
    <div data-testid="connector-card">{connector.displayName}</div>
  ),
}));

const renderAt = (path: string) => {
  const router = createMemoryRouter(
    [
      {
        path: '/settings/connector',
        element: <PlatformConnectorAuthorization />,
      },
    ],
    { initialEntries: [path] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
};

describe('PlatformConnectorAuthorization search sync', () => {
  beforeEach(() => {
    listManaged.mockClear();
    mutate.mockClear();
  });

  it('keeps the search input, SWR key, and results aligned on history query changes', async () => {
    const { router } = renderAt('/settings/connector?connector_q=sales');

    expect(screen.getByDisplayValue('sales')).toBeTruthy();
    expect(screen.getByTestId('connector-card').textContent).toBe('Result for sales');
    expect(listManaged).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'sales', limit: 50 }),
    );
    expect(buildManagedConnectorListKey({ limit: 50, query: 'sales' })).toEqual([
      'managedConnector.list',
      null,
      50,
      'sales',
    ]);

    // Simulate browser back to a prior finance query (history-driven URL change).
    await act(async () => {
      await router.navigate('/settings/connector?connector_q=finance');
    });

    await waitFor(() => {
      expect(screen.getByDisplayValue('finance')).toBeTruthy();
    });
    expect(screen.getByTestId('connector-card').textContent).toBe('Result for finance');
    expect(listManaged).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'finance', limit: 50 }),
    );

    // History back to no query clears the draft and list filter together.
    await act(async () => {
      await router.navigate('/settings/connector');
    });

    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
    });
    expect(screen.getByTestId('connector-card').textContent).toBe('All connectors');
    expect(listManaged).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: undefined, limit: 50 }),
    );
  });
});
