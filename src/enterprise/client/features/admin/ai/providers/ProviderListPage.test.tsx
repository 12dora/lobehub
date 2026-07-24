// @vitest-environment happy-dom
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type { AdminAiProviderListItem } from '../types';
import ProviderListPage from './ProviderListPage';

const mocks = vi.hoisted(() => ({
  listData: {
    items: [] as AdminAiProviderListItem[],
    nextCursor: null as string | null,
  },
  mutate: vi.fn(),
  openDeleteProviderModal: vi.fn(),
  permissions: [] as string[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_target, property) => String(property) }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ children, message, description, extra }: any) => (
    <div role="alert">
      {message}
      {description}
      {extra}
      {children}
    </div>
  ),
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Input: (props: any) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button type="button" onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Select: ({ 'aria-label': ariaLabel, onChange, options, value }: any) => (
    <select
      aria-label={ariaLabel}
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value || undefined)}
    >
      <option value="">—</option>
      {options?.map((option: any) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: mocks.permissions,
  }),
}));

vi.mock('../hooks/useAdminAiCatalog', () => ({
  refreshAdminAiProviderLists: vi.fn(),
  useFetchAdminAiProviders: () => ({
    data: mocks.listData,
    error: undefined,
    isLoading: false,
    mutate: mocks.mutate,
  }),
}));

vi.mock('@/enterprise/client/services/adminAiCatalog', () => ({
  adminAiCatalogService: {
    createProvider: vi.fn(),
    getProvider: vi.fn(),
    listProviders: vi.fn(),
  },
}));

vi.mock('./openCreateProviderModal', () => ({
  openCreateProviderModal: vi.fn(),
}));

vi.mock('./openDeleteProviderModal', () => ({
  openDeleteProviderModal: mocks.openDeleteProviderModal,
}));

vi.mock('../../primitives/AdminPageTemplate', () => ({
  default: ({
    actions,
    children,
    title,
    toolbar,
  }: {
    actions?: ReactNode;
    children?: ReactNode;
    title?: ReactNode;
    toolbar?: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <div data-testid="actions">{actions}</div>
      <div data-testid="toolbar">{toolbar}</div>
      {children}
    </div>
  ),
}));

vi.mock('../../primitives/StatusBadge', () => ({
  default: ({ status }: { status: string }) => <span data-testid="status">{status}</span>,
}));

/**
 * Lightweight table stand-in: renders each row's action cell so component-level
 * hard-delete gating is exercised without pulling full antd Table into the harness.
 */
vi.mock('../../primitives/DataTable', () => ({
  default: ({
    columns,
    dataSource,
  }: {
    columns: Array<{
      key?: string;
      render?: (value: unknown, item: AdminAiProviderListItem) => ReactNode;
    }>;
    dataSource?: AdminAiProviderListItem[];
  }) => {
    const actionColumn = columns.find((column) => column.key === 'actions');
    return (
      <table>
        <tbody>
          {(dataSource ?? []).map((item) => (
            <tr data-testid={`provider-row-${item.id}`} key={item.id}>
              <td>{item.displayName}</td>
              {actionColumn ? (
                <td data-testid={`provider-actions-${item.id}`}>
                  {actionColumn.render?.(undefined, item) ?? null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    );
  },
}));

const listItem = (
  override: Partial<AdminAiProviderListItem> & Pick<AdminAiProviderListItem, 'id' | 'revision'>,
): AdminAiProviderListItem =>
  ({
    checkModel: null,
    connectionTest: null,
    config: {},
    description: null,
    displayName: override.displayName ?? `Provider ${override.id}`,
    enabled: true,
    fetchOnClient: false,
    logo: null,
    providerKey: override.providerKey ?? override.id,
    secret: { configured: false, updatedAt: null },
    settings: {},
    sort: 0,
    source: 'custom',
    status: override.status ?? (override.revision > 0 ? 'published' : 'draft'),
    ...override,
  }) as AdminAiProviderListItem;

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/ai/catalog/providers']}>
      <ProviderListPage />
    </MemoryRouter>,
  );

describe('ProviderListPage hard-delete gate wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AI_PROVIDER_READ,
      PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE,
    ];
    mocks.listData = {
      items: [
        listItem({
          displayName: 'Never Published Draft',
          id: 'draft-provider',
          providerKey: 'draft-provider',
          revision: 0,
          status: 'draft',
        }),
        listItem({
          displayName: 'Published Provider',
          id: 'published-provider',
          providerKey: 'published-provider',
          revision: 3,
          status: 'published',
        }),
      ],
      nextCursor: null,
    };
  });

  it('renders hard-delete only for revision-zero drafts and hides it for published rows', () => {
    renderPage();

    const draftActions = screen.getByTestId('provider-actions-draft-provider');
    const publishedActions = screen.getByTestId('provider-actions-published-provider');

    // Component must call canHardDeleteAiProvider in the actions column — not only export the helper.
    expect(
      within(draftActions).getByRole('button', { name: 'aiCatalog.providers.actions.delete' }),
    ).toBeTruthy();
    expect(
      within(publishedActions).queryByRole('button', {
        name: 'aiCatalog.providers.actions.delete',
      }),
    ).toBeNull();
    // Empty actions cell for published: gate returns null (hidden), not a disabled control.
    expect(publishedActions.textContent?.trim() ?? '').toBe('');
  });

  it('omits the actions column entirely without delete permission', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AI_PROVIDER_READ];
    renderPage();

    expect(screen.queryByTestId('provider-actions-draft-provider')).toBeNull();
    expect(screen.queryByRole('button', { name: 'aiCatalog.providers.actions.delete' })).toBeNull();
  });
});
