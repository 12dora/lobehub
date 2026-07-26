/**
 * @vitest-environment happy-dom
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import WorkspaceConnectorSettings from '@/routes/(main)/[workspaceSlug]/settings/connector';
import PersonalConnectorSettings from '@/routes/(main)/settings/connector';

import { buildManagedConnectorListKey } from './swrKeys';

const listManaged = vi.fn();
const mutate = vi.fn();
const managedResource = vi.hoisted(() => ({ managed: true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/features/ManagedResources', () => ({
  ManagedResourceTransition: ({ children, state }: { children: ReactNode; state: string }) => (
    <div data-managed-resource-state={state}>{children}</div>
  ),
  useManagedResource: () => ({
    error: undefined,
    loading: false,
    managed: managedResource.managed,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/routes/(main)/settings/skill', () => ({
  ToolSettings: () => <div data-testid="ordinary-tool-settings">ordinary-tool-settings</div>,
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

const renderAt = (path: string, element: ReactNode = <PersonalConnectorSettings />) => {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element,
      },
    ],
    { initialEntries: [path] },
  );
  const view = render(<RouterProvider router={router} />);
  return { router, ...view };
};

describe('PlatformConnectorAuthorization search sync', () => {
  beforeEach(() => {
    managedResource.managed = true;
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

  it('renders authorization from both production routes only when Connectors are managed', () => {
    const personal = renderAt('/settings/connector');
    expect(screen.getByTestId('connector-card')).toBeTruthy();
    expect(
      personal.container.querySelector('[data-managed-resource-state="managed"]'),
    ).toBeTruthy();
    personal.unmount();

    const workspace = renderAt('/acme/settings/connector', <WorkspaceConnectorSettings />);
    expect(screen.getByTestId('connector-card')).toBeTruthy();
    workspace.unmount();

    managedResource.managed = false;
    const unmanaged = renderAt('/settings/connector');
    expect(screen.getByTestId('ordinary-tool-settings')).toBeTruthy();
    expect(screen.queryByTestId('connector-card')).toBeNull();
    expect(
      unmanaged.container.querySelector('[data-managed-resource-state="content"]'),
    ).toBeTruthy();
  });
});
