// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentListPage from './AgentListPage';
import type { AdminAgentListItem } from './types';

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  confirmModal: vi.fn(),
  defaultAgent: {} as Record<string, unknown>,
  defaultAgentMutate: vi.fn(),
  fetchDetail: vi.fn(),
  get: vi.fn(),
  list: {} as Record<string, unknown>,
  listInputs: [] as unknown[],
  openDelete: vi.fn(),
  openEditor: vi.fn(),
  permissions: [] as string[],
  provisionDefaultInbox: vi.fn(),
  refresh: vi.fn(),
  removeItem: vi.fn(),
  rowActionParams: [] as unknown[],
  runAdminMutation: vi.fn(),
  setDefaultInbox: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  updateItem: vi.fn(),
}));

// NOTE: AsyncBoundary is intentionally NOT mocked — this exercises its real
// loading → error → empty → data precedence against the hook's settled signal.
vi.mock('antd-style', () => ({
  createStaticStyles: (
    factory: (helpers: { css: (s: TemplateStringsArray) => string }) => Record<string, string>,
  ) => factory({ css: (s) => String(s.join('')) }),
  cssVar: new Proxy(
    {},
    {
      get: (_target, key) => String(key),
    },
  ),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({ authMethod: 'password', permissions: mocks.permissions }),
}));
vi.mock('./useAdminAgents', () => ({
  fetchAdminAgentDetail: (...args: unknown[]) => mocks.fetchDetail(...args),
  useAdminAgentListPagination: (input: unknown) => {
    mocks.listInputs.push(structuredClone(input));
    return mocks.list;
  },
  useDefaultAdminAgent: () => mocks.defaultAgent,
}));
// The takeover's reauth retry belongs to runAdminMutation's own tests; here it just commits.
vi.mock('@/enterprise/client/features/admin/primitives/runAdminMutation', () => ({
  runAdminMutation: (...args: unknown[]) => mocks.runAdminMutation(...args),
}));
vi.mock('i18next', () => ({ default: { language: 'en-US', resolvedLanguage: 'zh-CN' } }));
vi.mock('./openAgentEditorModal', () => ({
  openAgentEditorModal: (...args: unknown[]) => mocks.openEditor(...args),
}));
vi.mock('./pruneLegacyAgentDrafts', () => ({ usePruneLegacyAdminAgentDrafts: vi.fn() }));
vi.mock('./useAgentRowActions', () => ({
  useAgentRowActions: (params: unknown) => {
    mocks.rowActionParams.push(params);
    return { archive: mocks.archive, setDefaultInbox: mocks.setDefaultInbox };
  },
}));
vi.mock('./openDeleteAgentModal', () => ({
  openDeleteAgentModal: (...args: unknown[]) => mocks.openDelete(...args),
}));
vi.mock('@/enterprise/client/services/adminAgents', () => ({
  adminAgentsService: {
    get: (...args: unknown[]) => mocks.get(...args),
    provisionDefaultInbox: (...args: unknown[]) => mocks.provisionDefaultInbox(...args),
  },
}));
// Only the brand mark is stubbed — it drags in the real Icon styles, which the
// antd-style stub above cannot serve. The loader itself stays real.
vi.mock('@lobehub/ui/brand', () => ({
  BrandLoading: () => <span />,
  LobeHubText: () => <span />,
}));
// BrandTextLoading is deliberately NOT mocked: the loading assertion below has to
// see the real inline loader, so that losing its `role="status"` fails here
// instead of being papered over by a role-injecting stub.
vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => <div role="status">loading</div>,
}));
vi.mock('@/components/AsyncError', () => ({
  default: ({ onRetry }: { onRetry?: () => void }) => (
    <div role="alert">
      error<button onClick={onRetry}>retry</button>
    </div>
  ),
}));
vi.mock('@lobehub/ui', () => ({
  Avatar: ({ avatar }: { avatar?: string }) => <img alt="avatar" src={avatar} />,
  Block: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  // Spreads props like the real component: the inline loader's `role="status"`
  // and its accessible label reach the DOM through here.
  Center: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  Empty: ({ action, description }: { action?: ReactNode; description?: ReactNode }) => (
    <div>
      {description}
      {action}
    </div>
  ),
  Flexbox: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <div data-testid={props['data-testid'] as string | undefined}>{children}</div>
  ),
  Icon: () => <span />,
  Input: (props: any) => <input {...props} />,
  Tag: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, loading, ...props }: any) => (
    <button data-loading={String(Boolean(loading))} {...props}>
      {children}
    </button>
  ),
  confirmModal: (...args: unknown[]) => mocks.confirmModal(...args),
  // Items render inline: the menu's own open/close behaviour is base-ui's, not this page's.
  DropdownMenu: ({ children, items }: any) => (
    <span data-testid="row-more">
      {children}
      {(items ?? []).map((item: any) => (
        <button
          data-danger={String(Boolean(item.danger))}
          data-desc={item.desc ?? ''}
          disabled={Boolean(item.disabled)}
          key={item.key}
          onClick={item.onClick}
        >
          {item.label}
        </button>
      ))}
    </span>
  ),
  Select: (props: any) => (
    <select
      aria-label={props['aria-label']}
      value={props.value ?? ''}
      onChange={(event) => props.onChange?.(event.target.value || undefined)}
    >
      <option value="">—</option>
      {(props.options ?? []).map((option: { label: string; value: string }) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  toast: {
    error: (...args: unknown[]) => mocks.toastError(...args),
    success: (...args: unknown[]) => mocks.toastSuccess(...args),
    warning: (...args: unknown[]) => mocks.toastWarning(...args),
  },
}));
vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({ actions, children, toolbar }: any) => (
    <main>
      {actions}
      {toolbar}
      {children}
    </main>
  ),
}));
vi.mock('../primitives/DataTable', () => ({
  default: ({
    columns,
    dataSource,
    emptyDescription,
    onChange,
    onRowActivate,
    rowSelection,
    scroll,
    size,
    toolbar,
  }: {
    columns: Array<{
      filters?: Array<{ text: ReactNode; value: string }>;
      filteredValue?: Array<string | number> | null;
      key?: string;
      render?: (v: unknown, item: AdminAgentListItem) => ReactNode;
      title?: ReactNode;
      width?: number;
    }>;
    dataSource: AdminAgentListItem[];
    emptyDescription?: ReactNode;
    onChange?: (meta: {
      filters: Record<string, Array<string | number> | null>;
      pagination: false;
      sorter: Record<string, never>;
    }) => void;
    onRowActivate?: (record: AdminAgentListItem) => void;
    rowSelection?: {
      columnWidth?: number;
      preserveSelectedRowKeys?: boolean;
      selectedRowKeys?: string[];
      onChange?: (keys: string[], rows: AdminAgentListItem[]) => void;
    };
    scroll?: { x?: number };
    size?: string;
    toolbar?: ReactNode;
  }) => (
    <div
      data-preserve-selected={String(Boolean(rowSelection?.preserveSelectedRowKeys))}
      data-row-activate={String(Boolean(onRowActivate))}
      data-scroll-x={scroll?.x}
      data-selection-width={rowSelection?.columnWidth ?? ''}
      data-size={size}
    >
      {toolbar}
      {columns.map((column) =>
        column.filters ? (
          <select
            aria-label={typeof column.title === 'string' ? column.title : String(column.key)}
            key={column.key}
            value={column.filteredValue?.[0] ?? ''}
            onChange={(event) =>
              onChange?.({
                filters: { [String(column.key)]: event.target.value ? [event.target.value] : null },
                pagination: false,
                sorter: {},
              })
            }
          >
            <option value="">—</option>
            {column.filters.map((option) => (
              <option key={option.value} value={option.value}>
                {option.text}
              </option>
            ))}
          </select>
        ) : null,
      )}
      {dataSource.length === 0 ? <div>{emptyDescription}</div> : null}
      <div>rows:{dataSource.length}</div>
      {dataSource.map((item) => (
        <div key={item.identity.id}>
          {rowSelection ? (
            <input
              aria-label={`select:${item.identity.id}`}
              checked={(rowSelection.selectedRowKeys ?? []).includes(item.identity.id)}
              type="checkbox"
              onChange={(event) => {
                const previous = rowSelection.selectedRowKeys ?? [];
                const keys = event.target.checked
                  ? [...previous, item.identity.id]
                  : previous.filter((key) => key !== item.identity.id);
                rowSelection.onChange?.(
                  keys,
                  dataSource.filter((row) => keys.includes(row.identity.id)),
                );
              }}
            />
          ) : null}
          <button onClick={() => onRowActivate?.(item)}>activate:{item.identity.id}</button>
          {columns.map((column) => (
            <div key={column.key}>{column.render?.(undefined, item)}</div>
          ))}
        </div>
      ))}
      <div>columns:{columns.map((column) => column.key).join(',')}</div>
      <div>widths:{columns.map((column) => String(column.width ?? '')).join(',')}</div>
    </div>
  ),
}));
vi.mock('../primitives/StatusBadge', () => ({ default: () => <span>status</span> }));

const item = (id: string, over: Partial<AdminAgentListItem['identity']> = {}): AdminAgentListItem =>
  ({
    assignmentCount: 0,
    displayName: id,
    identity: { agentKey: id, id, isDefault: false, systemKey: null, status: 'published', ...over },
    publishedVersion: null,
  }) as never;

/** What `admin.agents.save` returns: advanced CAS + the version it just published. */
const saveOutput = {
  draftToken: 'd'.repeat(64),
  identity: { agentKey: 'agent-1', id: 'agent-1', isDefault: false, status: 'published' },
  invalidationStatus: 'delivered',
  version: { config: { displayName: 'Research v2' }, id: 'version-2', version: '1.0.1' },
};

/** The editor modal's committed-save callback, as the list passes it in. */
type SavedHandler = (
  output: typeof saveOutput | null,
  meta: { assignmentsChanged: boolean; created: boolean },
) => Promise<void>;

const pagination = (over: Record<string, unknown>) => ({
  boundaryData: undefined,
  error: undefined,
  hasMore: false,
  isEmpty: false,
  isLoadingInitial: false,
  isLoadingMore: false,
  items: [],
  loadMore: vi.fn(),
  loadMoreError: false,
  refresh: mocks.refresh,
  removeItem: mocks.removeItem,
  retry: vi.fn(),
  updateItem: mocks.updateItem,
  ...over,
});

/** What `useDefaultAdminAgent` hands the page: an SWR result whose data is the pinned snapshot. */
const defaultAgentState = (over: Record<string, unknown> = {}) => ({
  data: undefined,
  error: undefined,
  mutate: mocks.defaultAgentMutate,
  ...over,
});

/** A provisioned default: the pointer row plus the published version the card reads. */
const defaultSnapshot = (id = 'agent-inbox') => ({
  detail: {
    identity: { currentVersionId: `version-${id}`, id },
    versions: [
      {
        config: { avatar: '🤖', backgroundColor: '#222', displayName: 'Company assistant' },
        dependencySnapshot: { model: { modelKey: 'gpt-4o-mini', providerKey: 'openai' } },
        id: `version-${id}`,
      },
    ],
  },
  item: {
    ...item(id, {
      currentVersionId: `version-${id}`,
      isDefault: true,
      systemKey: 'default-inbox',
    }),
    displayName: 'Company assistant',
    publishedVersion: '1.2.0',
  },
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <AgentListPage />
    </MemoryRouter>,
  );

describe('AgentListPage with the real AsyncBoundary', () => {
  beforeEach(() => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ];
    mocks.list = pagination({});
    mocks.listInputs = [];
    mocks.defaultAgent = defaultAgentState({ data: null });
    mocks.defaultAgentMutate.mockReset().mockResolvedValue(undefined);
    mocks.confirmModal.mockReset();
    mocks.provisionDefaultInbox.mockReset();
    mocks.toastSuccess.mockReset();
    // Default: the mutation commits. On failure it mirrors the real primitive — the caller's own
    // error surface replaces the default toast when it provides one.
    mocks.runAdminMutation
      .mockReset()
      .mockImplementation(
        async ({
          onError,
          run,
        }: {
          onError?: (error: unknown) => Promise<void> | void;
          run: () => Promise<void>;
        }) => {
          try {
            await run();
            return true;
          } catch (error) {
            if (onError) await onError(error);
            else mocks.toastError(error);
            return false;
          }
        },
      );
    mocks.archive.mockReset();
    mocks.setDefaultInbox.mockReset();
    mocks.rowActionParams = [];
    mocks.fetchDetail.mockReset();
    mocks.openEditor.mockReset();
    mocks.openDelete.mockReset();
    mocks.refresh.mockReset().mockResolvedValue(undefined);
    mocks.removeItem.mockReset().mockResolvedValue(undefined);
    mocks.get.mockReset();
    mocks.toastError.mockReset();
    mocks.toastWarning.mockReset();
    mocks.updateItem.mockReset().mockResolvedValue(undefined);
  });

  it('shows the real loading state before the first page settles (data undefined)', async () => {
    mocks.list = pagination({ boundaryData: undefined, isLoadingInitial: true });
    renderPage();
    // The loader is delayed (DelayedFallback) so a fast fetch never flashes it.
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.list.empty.default')).toBeNull();
  });

  it('renders the initial-fetch error (not empty) when the first page fails', () => {
    mocks.list = pagination({ boundaryData: undefined, error: new Error('offline') });
    renderPage();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('agentCatalog.list.empty.default')).toBeNull();
  });

  it('shows the empty state only after a settled empty page', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();
    expect(screen.getByText('agentCatalog.list.empty.default')).toBeTruthy();
  });

  it('offers a clear-filters action for a settled filtered empty result', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    render(
      <MemoryRouter initialEntries={['/admin/agents?q=missing']}>
        <AgentListPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('agentCatalog.list.empty.filtered')).toBeTruthy();
    expect(screen.getByText('primitives.filterBar.clear')).toBeTruthy();
  });

  it('renders rows and a load-more control when more pages remain', () => {
    mocks.list = pagination({ boundaryData: [item('a')], hasMore: true, items: [item('a')] });
    renderPage();
    expect(screen.getByText('rows:1')).toBeTruthy();
    expect(screen.getByText('agentCatalog.list.loadMore')).toBeTruthy();
  });

  it('keeps content and shows an inline retry when a later page fails', () => {
    mocks.list = pagination({
      boundaryData: [item('a')],
      items: [item('a')],
      loadMoreError: true,
    });
    renderPage();
    expect(screen.getByText('rows:1')).toBeTruthy();
    expect(screen.getByText('agentCatalog.list.loadMoreError')).toBeTruthy();
  });

  it('does not expose create to a read-only auditor', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();
    expect(screen.queryByText('agentCatalog.create.submit')).toBeNull();
  });

  it('keeps search in the table toolbar and status as a column-header filter', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true, items: [] });
    renderPage();
    const toolbar = screen.getByTestId('agent-list-toolbar');
    expect(toolbar.querySelector('input')).toBeTruthy();
    expect(toolbar.querySelector('select')).toBeNull();
    expect(screen.queryByText('agentCatalog.list.applySearch')).toBeNull();
    expect(screen.getByLabelText('agentCatalog.list.columns.status')).toBeTruthy();
  });

  it('applies the status header filter to the list query', async () => {
    mocks.list = pagination({ boundaryData: [item('a')], items: [item('a')] });
    renderPage();

    fireEvent.change(screen.getByLabelText('agentCatalog.list.columns.status'), {
      target: { value: 'published' },
    });

    await waitFor(() => expect(mocks.listInputs.at(-1)).toMatchObject({ status: 'published' }));
  });

  it('refreshes the bound infinite list after a successful delete via removeItem', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.get.mockResolvedValue({
      draftToken: 'a'.repeat(64),
      identity: {
        agentKey: 'agent-1',
        draftSequence: 0,
        id: 'agent-1',
        isDefault: false,
        migrationRequired: false,
        revision: 3,
        status: 'published',
        systemKey: null,
      },
    });
    mocks.list = pagination({
      boundaryData: [item('agent-1')],
      items: [item('agent-1')],
    });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.delete.action'));
    // List delete fetches authoritative CAS before opening the modal.
    await waitFor(() =>
      expect(mocks.openDelete).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          displayName: 'agent-1',
          expectedDraftToken: 'a'.repeat(64),
          expectedRevision: 3,
        }),
      ),
    );
    expect(mocks.get).toHaveBeenCalledWith({ id: 'agent-1' });
    const { onDeleted } = mocks.openDelete.mock.calls[0]![0] as {
      onDeleted: () => void | Promise<void>;
    };
    await onDeleted();
    // Committed delete drops the row from bound pages (not a bare revalidate that can leave it).
    expect(mocks.removeItem).toHaveBeenCalledWith('agent-1');
    // The pinned key goes with it — the card must never point at a deleted assistant.
    expect(mocks.defaultAgentMutate).toHaveBeenCalledOnce();
  });

  it('surfaces a localized preflight failure without opening the delete modal', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.get.mockRejectedValue(new Error('offline'));
    mocks.list = pagination({
      boundaryData: [item('agent-1')],
      items: [item('agent-1')],
    });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.delete.action'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.openDelete).not.toHaveBeenCalled();
    // Row remains — preflight never committed a delete.
    expect(screen.getByText('rows:1')).toBeTruthy();
  });

  it('still invokes removeItem when post-delete revalidation rejects', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.get.mockResolvedValue({
      draftToken: 'a'.repeat(64),
      identity: {
        agentKey: 'agent-1',
        draftSequence: 0,
        id: 'agent-1',
        isDefault: false,
        migrationRequired: false,
        revision: 3,
        status: 'published',
        systemKey: null,
      },
    });
    // removeItem optimistically drops then revalidates; revalidation failure must still resolve
    // the optimistic drop path (caller catches at openDeleteAgentModal).
    mocks.removeItem.mockRejectedValueOnce(new Error('revalidate failed'));
    mocks.list = pagination({
      boundaryData: [item('agent-1')],
      items: [item('agent-1')],
    });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.delete.action'));
    await waitFor(() => expect(mocks.openDelete).toHaveBeenCalled());
    const { onDeleted } = mocks.openDelete.mock.calls[0]![0] as {
      onDeleted: () => void | Promise<void>;
    };
    await expect(onDeleted()).rejects.toThrow('revalidate failed');
    expect(mocks.removeItem).toHaveBeenCalledWith('agent-1');
  });

  it('refreshes the bound infinite list after create instead of leaving for a detail page', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_CREATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ];
    // The platform already has its default assistant, so nothing else on this page writes.
    mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot() });
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();

    // Header action and empty-state CTA share the same label — either path uses the same callback.
    fireEvent.click(screen.getAllByText('agentCatalog.create.submit')[0]!);
    expect(mocks.openEditor).toHaveBeenCalledOnce();
    const { agent, onSaved } = mocks.openEditor.mock.calls[0]![0] as {
      agent?: unknown;
      onSaved: SavedHandler;
    };
    // No agent → create mode.
    expect(agent).toBeUndefined();
    await onSaved(
      { ...saveOutput, identity: { ...saveOutput.identity, id: 'new-agent' } } as never,
      { assignmentsChanged: false, created: true },
    );
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    // Nothing lands on a single row: a created assistant is not in the bound pages yet.
    expect(mocks.updateItem).not.toHaveBeenCalled();
  });

  it('reports a failed post-create revalidation instead of a silently incomplete list', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_CREATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ];
    mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot() });
    mocks.refresh.mockRejectedValueOnce(new Error('offline'));
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();

    fireEvent.click(screen.getAllByText('agentCatalog.create.submit')[0]!);
    const { onSaved } = mocks.openEditor.mock.calls[0]![0] as { onSaved: SavedHandler };
    await onSaved(
      { ...saveOutput, identity: { ...saveOutput.identity, id: 'new-agent' } },
      {
        assignmentsChanged: false,
        created: true,
      },
    );
    expect(mocks.toastWarning).toHaveBeenCalledWith('agentCatalog.recovery.refreshFailed');
  });

  it('hides create from an operator who can create but cannot publish', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_CREATE];
    mocks.list = pagination({ boundaryData: [], isEmpty: true });
    renderPage();
    expect(screen.queryByText('agentCatalog.create.submit')).toBeNull();
  });

  it('opens the editor from a row with the authoritative aggregate, then refreshes on save', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ];
    const detail = { identity: { id: 'agent-1' }, versions: [] };
    mocks.fetchDetail.mockResolvedValue(detail);
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.action.edit'));
    await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
    // The row itself carries no draftToken / config — never author from it.
    expect(mocks.fetchDetail).toHaveBeenCalledWith('agent-1', expect.anything(), false);
    const { agent, canAssign, onSaved } = mocks.openEditor.mock.calls[0]![0] as {
      agent: typeof detail;
      canAssign?: boolean;
      onSaved: SavedHandler;
    };
    expect(agent).toBe(detail);
    // No AGENT_ASSIGN in this operator's grant → the modal never offers 分配策略.
    expect(canAssign).toBe(false);
    await onSaved(saveOutput as never, { assignmentsChanged: false, created: false });

    // The committed name / version / CAS land on the row itself before revalidation.
    expect(mocks.updateItem).toHaveBeenCalledWith('agent-1', expect.any(Function));
    const [, apply] = mocks.updateItem.mock.calls[0] as [
      string,
      (row: AdminAgentListItem) => AdminAgentListItem,
    ];
    expect(apply(item('agent-1'))).toMatchObject({
      displayName: 'Research v2',
      publishedVersion: '1.0.1',
    });
    // An ordinary assistant is not the pinned one: no reason to re-read the pointer aggregate.
    expect(mocks.defaultAgentMutate).not.toHaveBeenCalled();
  });

  it('reports a failed post-save revalidation instead of leaving a stale row unexplained', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ];
    mocks.fetchDetail.mockResolvedValue({ identity: { id: 'agent-1' }, versions: [] });
    mocks.updateItem.mockRejectedValueOnce(new Error('revalidate failed'));
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.action.edit'));
    await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
    const { onSaved } = mocks.openEditor.mock.calls[0]![0] as { onSaved: SavedHandler };
    await onSaved(saveOutput as never, { assignmentsChanged: false, created: false });
    expect(mocks.toastWarning).toHaveBeenCalledWith('agentCatalog.recovery.refreshFailed');
  });

  it('surfaces a localized editor preflight failure without opening the editor', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ];
    mocks.fetchDetail.mockRejectedValue(new Error('offline'));
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.action.edit'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
    expect(mocks.openEditor).not.toHaveBeenCalled();
  });

  it('drops the version column and sizes every remaining one so CJK headers survive', () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ];
    mocks.list = pagination({ boundaryData: [item('a')], items: [item('a')] });
    const { container } = renderPage();

    // Versions are no longer a concept the operator sees.
    expect(screen.getByText(/^columns:/).textContent).toBe(
      'columns:agent,status,assignmentCount,isDefault,actions',
    );
    // Every column has an explicit width — that is what puts the table in `fixed` layout.
    expect(screen.getByText(/^widths:/).textContent).toBe('widths:340,140,100,120,200');
    expect(container.querySelector('[data-scroll-x]')?.getAttribute('data-scroll-x')).toBe('900');
    expect(container.querySelector('[data-size]')?.getAttribute('data-size')).toBe('small');
  });

  it('opens the editor from a row click now that there is no detail page', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ];
    const detail = { identity: { id: 'agent-1' }, versions: [] };
    mocks.fetchDetail.mockResolvedValue(detail);
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    fireEvent.click(screen.getByText('activate:agent-1'));
    await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
    expect(mocks.fetchDetail).toHaveBeenCalledWith('agent-1', expect.anything(), false);
  });

  it('leaves rows inert for an operator with neither edit nor assign rights', () => {
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    const { container } = renderPage();
    expect(container.querySelector('[data-row-activate]')?.getAttribute('data-row-activate')).toBe(
      'false',
    );
  });

  it('passes the assign grant into the editor modal so it can offer 分配策略', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      PLATFORM_PERMISSIONS.AGENT_ASSIGN,
    ];
    mocks.fetchDetail.mockResolvedValue({ identity: { id: 'agent-1' }, versions: [] });
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.action.edit'));
    await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
    expect(mocks.openEditor.mock.calls[0]![0]).toMatchObject({ canAssign: true });
  });

  it('revalidates the whole list when a submit also wrote assignments', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ];
    mocks.fetchDetail.mockResolvedValue({ identity: { id: 'agent-1' }, versions: [] });
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.action.edit'));
    await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
    const { onSaved } = mocks.openEditor.mock.calls[0]![0] as { onSaved: SavedHandler };

    // Assignment counts are not in the save output — patching the row would show a half-truth.
    await onSaved(saveOutput as never, { assignmentsChanged: true, created: false });
    expect(mocks.updateItem).not.toHaveBeenCalled();
    expect(mocks.refresh).toHaveBeenCalledOnce();

    // An assignments-only submit carries no output at all.
    await onSaved(null, { assignmentsChanged: true, created: false });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
  });

  it('offers 设为默认 for a published non-default row, gated on the publish grant', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_PUBLISH];
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    fireEvent.click(screen.getByText('agentCatalog.defaultSwitch.action'));
    expect(mocks.setDefaultInbox).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ id: 'agent-1' }) }),
    );
  });

  it('hides 设为默认 from the row that already IS the default, and from an archived one', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_PUBLISH];
    mocks.list = pagination({
      boundaryData: [item('a', { isDefault: true }), item('b', { status: 'archived' })],
      items: [item('a', { isDefault: true }), item('b', { status: 'archived' })],
    });
    renderPage();
    expect(screen.queryByText('agentCatalog.defaultSwitch.action')).toBeNull();
  });

  it('hides 设为默认 entirely from an operator without the publish grant', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();
    expect(screen.queryByText('agentCatalog.defaultSwitch.action')).toBeNull();
  });

  it('keeps 归档 and 删除 behind 更多, both marked destructive', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    const more = screen.getByTestId('row-more');
    expect(more).toContainElement(screen.getByText('agentCatalog.archive.submit'));
    expect(more).toContainElement(screen.getByText('agentCatalog.delete.action'));
    for (const label of ['agentCatalog.archive.submit', 'agentCatalog.delete.action']) {
      expect(screen.getByText(label).getAttribute('data-danger')).toBe('true');
    }

    fireEvent.click(screen.getByText('agentCatalog.archive.submit'));
    expect(mocks.archive).toHaveBeenCalledWith(
      expect.objectContaining({ identity: expect.objectContaining({ id: 'agent-1' }) }),
    );
  });

  it('drops 归档 for an already-archived row, and both 归档 and 删除 for the default one', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.list = pagination({
      boundaryData: [item('a', { status: 'archived' })],
      items: [item('a', { status: 'archived' })],
    });
    const { unmount } = renderPage();
    expect(screen.queryByText('agentCatalog.archive.submit')).toBeNull();
    expect(screen.getByText('agentCatalog.delete.action')).toBeTruthy();
    unmount();

    mocks.list = pagination({
      boundaryData: [item('a', { isDefault: true })],
      items: [item('a', { isDefault: true })],
    });
    renderPage();
    // The default is every member's assistant; it is managed from the pinned card, not a row menu.
    expect(screen.queryByText('agentCatalog.archive.submit')).toBeNull();
    expect(screen.queryByText('agentCatalog.delete.action')).toBeNull();
  });

  it('drops the whole actions column for a read-only auditor', () => {
    mocks.list = pagination({ boundaryData: [item('a')], items: [item('a')] });
    renderPage();
    expect(screen.getByText(/^columns:/).textContent).toBe(
      'columns:agent,status,assignmentCount,isDefault',
    );
  });

  it('wires 设为默认 / 归档 to invalidate the table AND the pinned default card', async () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_PUBLISH];
    mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot() });
    mocks.list = pagination({ boundaryData: [item('a')], items: [item('a')] });
    renderPage();

    const { authMethod, onChanged } = mocks.rowActionParams.at(-1) as {
      authMethod: string;
      onChanged: () => Promise<void>;
    };
    expect(authMethod).toBe('password');
    // Promotion rewrites the pointer itself: refreshing only the table leaves the pinned card
    // showing the assistant that just stopped being everyone's default.
    await onChanged();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.defaultAgentMutate).toHaveBeenCalledOnce();
  });

  it('opens the editor for an assignment-only operator, with the config read-only', async () => {
    // AGENT_ASSIGN is independently grantable — gating the editor on canEdit alone locked these
    // operators out of the only surface that edits 分配策略.
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_ASSIGN];
    mocks.fetchDetail.mockResolvedValue({ identity: { id: 'agent-1' }, versions: [] });
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    const { container } = renderPage();

    // The row itself is still the way in.
    expect(container.querySelector('[data-row-activate]')?.getAttribute('data-row-activate')).toBe(
      'true',
    );
    fireEvent.click(screen.getByText('agentCatalog.action.assign'));
    await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
    expect(mocks.openEditor.mock.calls[0]![0]).toMatchObject({
      canAssign: true,
      canEditConfig: false,
    });
  });

  it('labels the action 编辑 and unlocks the config for a full editor', async () => {
    mocks.permissions = [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      PLATFORM_PERMISSIONS.AGENT_ASSIGN,
    ];
    mocks.fetchDetail.mockResolvedValue({ identity: { id: 'agent-1' }, versions: [] });
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    renderPage();

    expect(screen.queryByText('agentCatalog.action.assign')).toBeNull();
    fireEvent.click(screen.getByText('agentCatalog.action.edit'));
    await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
    expect(mocks.openEditor.mock.calls[0]![0]).toMatchObject({
      canAssign: true,
      canEditConfig: true,
    });
  });

  it('drops the removed draft status from the filter options', () => {
    mocks.list = pagination({ boundaryData: [], isEmpty: true, items: [] });
    renderPage();
    const options = [
      ...screen.getByLabelText('agentCatalog.list.columns.status').querySelectorAll('option'),
    ]
      .map((option) => option.getAttribute('value'))
      .filter(Boolean);
    expect(options).toEqual(['published', 'archived']);
  });
  it('offers no checkbox column to an operator without AGENT_DELETE', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ];
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    const { container } = renderPage();
    // A selection nothing can act on is dead chrome — and the 40px column is not reserved.
    expect(screen.queryByLabelText('select:agent-1')).toBeNull();
    expect(container.querySelector('[data-scroll-x]')?.getAttribute('data-scroll-x')).toBe('900');
  });

  it('reserves the 40px checkbox column and keeps keys across pages for a deleter', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
    const { container } = renderPage();
    const table = container.querySelector('[data-scroll-x]')!;
    expect(table.getAttribute('data-selection-width')).toBe('40');
    expect(table.getAttribute('data-preserve-selected')).toBe('true');
    // 900 + the checkbox column.
    expect(table.getAttribute('data-scroll-x')).toBe('940');
  });

  it('shows the selected count and one actions menu once rows are selected', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.list = pagination({
      boundaryData: [item('agent-1'), item('agent-2')],
      items: [item('agent-1'), item('agent-2')],
    });
    renderPage();

    expect(screen.queryByText('agentCatalog.list.bulk.actions')).toBeNull();
    fireEvent.click(screen.getByLabelText('select:agent-1'));

    expect(screen.getByText('agentCatalog.list.selectedCount')).toBeTruthy();
    expect(screen.getByText('agentCatalog.list.bulk.actions')).toBeTruthy();
    expect(screen.getByText('agentCatalog.bulk.archive.action')).toBeTruthy();
    expect(screen.getByText('agentCatalog.bulk.delete.action')).toBeTruthy();
  });

  it('disables the bulk entry whose selection holds no eligible row', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    // The default assistant is pinned above and never selectable here, so the reachable ineligible
    // selection is an already-archived row: it cannot be archived again, but it can still be deleted.
    const row = item('agent-archived', { status: 'archived' });
    mocks.list = pagination({ boundaryData: [row], items: [row] });
    renderPage();

    fireEvent.click(screen.getByLabelText('select:agent-archived'));
    const archive = screen.getByText('agentCatalog.bulk.archive.action') as HTMLButtonElement;
    const remove = screen.getByText('agentCatalog.bulk.delete.action') as HTMLButtonElement;
    expect(archive.disabled).toBe(true);
    // The reason is spelled out rather than left to a vanished menu entry.
    expect(archive.getAttribute('data-desc')).toBe('agentCatalog.bulk.archive.ineligible');
    expect(remove.disabled).toBe(false);
  });

  it('keeps a selected row that scrolled out of the loaded pages', () => {
    mocks.permissions = [PLATFORM_PERMISSIONS.AGENT_READ, PLATFORM_PERMISSIONS.AGENT_DELETE];
    mocks.list = pagination({
      boundaryData: [item('agent-1'), item('agent-2')],
      items: [item('agent-1'), item('agent-2')],
    });
    const { rerender } = renderPage();

    fireEvent.click(screen.getByLabelText('select:agent-1'));
    fireEvent.click(screen.getByLabelText('select:agent-2'));
    expect(screen.getByText('agentCatalog.list.selectedCount')).toBeTruthy();

    // A filter narrows the rendered page; the stored rows must survive so eligibility can still
    // be computed for rows antd no longer hands back.
    mocks.list = pagination({ boundaryData: [item('agent-2')], items: [item('agent-2')] });
    rerender(
      <MemoryRouter>
        <AgentListPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('agentCatalog.list.bulk.actions')).toBeTruthy();
  });

  describe('the pinned 默认助理 section', () => {
    it('shows the managed default with the presentation the members actually see', () => {
      mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot() });
      renderPage();

      expect(screen.getByText('agentCatalog.defaultAgent.title')).toBeTruthy();
      expect(screen.getByText('Company assistant')).toBeTruthy();
      // Avatar and model live on the published version, not on the list row.
      expect(screen.getByAltText('avatar').getAttribute('src')).toBe('🤖');
      expect(screen.getByText('openai · gpt-4o-mini')).toBeTruthy();
      // Saving IS publishing here, so a version number is an implementation detail no admin has
      // to reason about — the card never shows the one it reads for the avatar / model.
      expect(screen.queryByText('1.2.0')).toBeNull();
      expect(screen.queryByText('agentCatalog.defaultAgent.preparing')).toBeNull();
    });

    it('keeps the pinned default out of the table so it is not two rows to reconcile', () => {
      mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot() });
      // The row's own flag is behind here (a page loaded before the promotion) — the pointer id is
      // the fallback that still keeps the duplicate off screen.
      const rows = [item('agent-inbox'), item('agent-2')];
      mocks.list = pagination({ boundaryData: rows, items: rows });
      renderPage();

      expect(screen.getByText('rows:1')).toBeTruthy();
      expect(screen.queryByText('activate:agent-inbox')).toBeNull();
      expect(screen.getByText('activate:agent-2')).toBeTruthy();
    });

    it('drops the default row on the first page, without waiting for the pinned read', () => {
      // The rows already say which one is the default, so the duplicate never flashes on screen
      // while the (slower) pinned aggregate is still in flight.
      mocks.defaultAgent = defaultAgentState({ data: undefined });
      const rows = [item('agent-inbox', { isDefault: true }), item('agent-2')];
      mocks.list = pagination({ boundaryData: rows, items: rows });
      renderPage();

      expect(screen.getByText('rows:1')).toBeTruthy();
      expect(screen.queryByText('activate:agent-inbox')).toBeNull();
    });

    it('opens the editor for the pinned default through the authoritative aggregate', async () => {
      mocks.permissions = [
        PLATFORM_PERMISSIONS.AGENT_READ,
        PLATFORM_PERMISSIONS.AGENT_UPDATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      ];
      mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot() });
      const detail = { identity: { id: 'agent-inbox' }, versions: [] };
      mocks.fetchDetail.mockResolvedValue(detail);
      renderPage();

      fireEvent.click(screen.getByText('agentCatalog.action.edit'));
      await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
      expect(mocks.fetchDetail).toHaveBeenCalledWith('agent-inbox', expect.anything(), false);
      expect(mocks.openEditor.mock.calls[0]![0]).toMatchObject({ agent: detail });
    });

    it('refreshes the pinned card after the pinned assistant is saved from the editor', async () => {
      mocks.permissions = [
        PLATFORM_PERMISSIONS.AGENT_READ,
        PLATFORM_PERMISSIONS.AGENT_UPDATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      ];
      mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot() });
      // No table rows: the only 编辑 on screen belongs to the pinned card.
      mocks.list = pagination({ boundaryData: [], isEmpty: true });
      mocks.fetchDetail.mockResolvedValue({ identity: { id: 'agent-inbox' }, versions: [] });
      renderPage();

      fireEvent.click(screen.getByText('agentCatalog.action.edit'));
      await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
      const { onSaved } = mocks.openEditor.mock.calls[0]![0] as { onSaved: SavedHandler };
      await onSaved(
        { ...saveOutput, identity: { ...saveOutput.identity, id: 'agent-inbox' } },
        { assignmentsChanged: false, created: false },
      );

      // The committed name / version still land on the table row it also occupies…
      expect(mocks.updateItem).toHaveBeenCalledWith('agent-inbox', expect.any(Function));
      // …and the card is re-read, or it keeps rendering the name / avatar / model just replaced.
      expect(mocks.defaultAgentMutate).toHaveBeenCalledOnce();
    });

    it('refreshes the pinned card for an assignments-only save of the default', async () => {
      mocks.permissions = [
        PLATFORM_PERMISSIONS.AGENT_READ,
        PLATFORM_PERMISSIONS.AGENT_UPDATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      ];
      mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot() });
      mocks.list = pagination({ boundaryData: [], isEmpty: true });
      mocks.fetchDetail.mockResolvedValue({ identity: { id: 'agent-inbox' }, versions: [] });
      renderPage();

      fireEvent.click(screen.getByText('agentCatalog.action.edit'));
      await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
      const { onSaved } = mocks.openEditor.mock.calls[0]![0] as { onSaved: SavedHandler };
      // Such a submit carries no output at all — the edited id is what identifies the default.
      await onSaved(null, { assignmentsChanged: true, created: false });

      expect(mocks.refresh).toHaveBeenCalledOnce();
      expect(mocks.defaultAgentMutate).toHaveBeenCalledOnce();
    });

    it('refreshes the pinned card when a save makes its assistant the default', async () => {
      mocks.permissions = [
        PLATFORM_PERMISSIONS.AGENT_READ,
        PLATFORM_PERMISSIONS.AGENT_UPDATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      ];
      // The pointer read has not settled, so the promotion is only visible in the save output.
      mocks.defaultAgent = defaultAgentState({ data: undefined });
      mocks.list = pagination({ boundaryData: [item('agent-1')], items: [item('agent-1')] });
      mocks.fetchDetail.mockResolvedValue({ identity: { id: 'agent-1' }, versions: [] });
      renderPage();

      fireEvent.click(screen.getByText('agentCatalog.action.edit'));
      await waitFor(() => expect(mocks.openEditor).toHaveBeenCalledOnce());
      const { onSaved } = mocks.openEditor.mock.calls[0]![0] as { onSaved: SavedHandler };
      await onSaved(
        { ...saveOutput, identity: { ...saveOutput.identity, isDefault: true } },
        { assignmentsChanged: false, created: false },
      );

      expect(mocks.defaultAgentMutate).toHaveBeenCalledOnce();
    });

    it('initializes a missing default assistant itself, exactly once and without asking', async () => {
      mocks.permissions = [
        PLATFORM_PERMISSIONS.AGENT_READ,
        PLATFORM_PERMISSIONS.AGENT_CREATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
        PLATFORM_PERMISSIONS.AGENT_ASSIGN,
      ];
      mocks.defaultAgent = defaultAgentState({ data: null });
      mocks.provisionDefaultInbox.mockResolvedValue({ identity: { id: 'agent-new' } });
      const { unmount } = renderPage();

      // The default assistant is not something an admin opts into: no step to click, nothing to
      // confirm. Until it lands, the card says what is happening.
      expect(screen.getByText('agentCatalog.defaultAgent.preparing')).toBeTruthy();
      await waitFor(() => expect(mocks.provisionDefaultInbox).toHaveBeenCalledOnce());
      expect(mocks.confirmModal).not.toHaveBeenCalled();
      // The seeded copy follows the admin's own UI language.
      expect(mocks.provisionDefaultInbox).toHaveBeenCalledWith({ locale: 'zh-CN' });
      // Both the pinned card and the table now hold a row that did not exist a moment ago.
      await waitFor(() => expect(mocks.defaultAgentMutate).toHaveBeenCalledOnce());
      expect(mocks.refresh).toHaveBeenCalledOnce();
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'agentCatalog.defaultAgent.provision.success',
      );
      // Nobody asked for an editor — the assistant is seeded and editable when the admin wants it.
      expect(mocks.openEditor).not.toHaveBeenCalled();

      // Once the refreshed read lands, the assistant is simply there — and a page that opens on a
      // provisioned default writes nothing at all.
      unmount();
      mocks.defaultAgent = defaultAgentState({ data: defaultSnapshot('agent-new') });
      renderPage();
      expect(screen.getByText('Company assistant')).toBeTruthy();
      expect(screen.queryByText('agentCatalog.defaultAgent.preparing')).toBeNull();
      expect(mocks.provisionDefaultInbox).toHaveBeenCalledOnce();
    });

    it('keeps a failed initialization on the card, with a retry that is the only re-attempt', async () => {
      mocks.permissions = [
        PLATFORM_PERMISSIONS.AGENT_READ,
        PLATFORM_PERMISSIONS.AGENT_CREATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
        PLATFORM_PERMISSIONS.AGENT_ASSIGN,
      ];
      mocks.defaultAgent = defaultAgentState({ data: null });
      mocks.provisionDefaultInbox
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue({ identity: { id: 'agent-new' } });
      renderPage();

      expect(await screen.findByText('agentCatalog.defaultAgent.provision.error')).toBeTruthy();
      // Nobody clicked this, so the failure belongs next to the missing assistant, not in a toast
      // that appears out of nowhere.
      expect(mocks.toastError).not.toHaveBeenCalled();
      // A failure re-arms nothing: the card waits for a decision instead of hammering the server.
      expect(mocks.provisionDefaultInbox).toHaveBeenCalledOnce();

      fireEvent.click(screen.getByText('agentCatalog.dependency.retry'));
      await waitFor(() => expect(mocks.provisionDefaultInbox).toHaveBeenCalledTimes(2));
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        'agentCatalog.defaultAgent.provision.success',
      );
    });

    it('sends an operator who cannot initialize the default to one who can', () => {
      mocks.defaultAgent = defaultAgentState({ data: null });
      renderPage();

      expect(screen.getByText('agentCatalog.defaultAgent.provision.readOnly')).toBeTruthy();
      expect(screen.queryByText('agentCatalog.defaultAgent.preparing')).toBeNull();
      expect(mocks.provisionDefaultInbox).not.toHaveBeenCalled();
    });

    it('does not start an initialization the server would reject for a missing AGENT_ASSIGN', () => {
      // Provisioning the default also assigns it to everyone, so the server demands AGENT_ASSIGN
      // on top of create + publish. Starting the write here would replace the neutral "ask an
      // admin" message with a permission error the operator can do nothing about.
      mocks.permissions = [
        PLATFORM_PERMISSIONS.AGENT_READ,
        PLATFORM_PERMISSIONS.AGENT_CREATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      ];
      mocks.defaultAgent = defaultAgentState({ data: null });
      renderPage();

      expect(mocks.provisionDefaultInbox).not.toHaveBeenCalled();
      expect(screen.getByText('agentCatalog.defaultAgent.provision.readOnly')).toBeTruthy();
      expect(screen.queryByText('agentCatalog.defaultAgent.preparing')).toBeNull();
      // Creating an ordinary assistant is still theirs to do — only the default is out of reach.
      expect(screen.getByText('agentCatalog.create.submit')).toBeTruthy();
    });

    it('reports a failed pointer read instead of claiming there is no default', () => {
      mocks.defaultAgent = defaultAgentState({ data: undefined, error: new Error('offline') });
      renderPage();

      expect(screen.getByText('agentCatalog.defaultAgent.loadError')).toBeTruthy();
      expect(screen.queryByText('agentCatalog.defaultAgent.preparing')).toBeNull();
      // Nothing was ever loaded, so there is no card to keep and nothing a retry would preserve.
      expect(screen.queryByText('Company assistant')).toBeNull();
      expect(screen.queryByText('agentCatalog.dependency.retry')).toBeNull();
    });

    it('keeps the last loaded card with a retry when revalidation fails', () => {
      // Hiding the assistant every member is talking to because a background re-read failed is a
      // worse answer than showing it and saying it may be behind.
      mocks.defaultAgent = defaultAgentState({
        data: defaultSnapshot(),
        error: new Error('offline'),
      });
      renderPage();

      expect(screen.getByText('Company assistant')).toBeTruthy();
      expect(screen.getByText('openai · gpt-4o-mini')).toBeTruthy();
      expect(screen.getByText('agentCatalog.defaultAgent.loadError')).toBeTruthy();

      fireEvent.click(screen.getByText('agentCatalog.dependency.retry'));
      expect(mocks.defaultAgentMutate).toHaveBeenCalledOnce();
    });

    it('still initializes the default when the settled "no default" also failed to re-read', async () => {
      mocks.permissions = [
        PLATFORM_PERMISSIONS.AGENT_READ,
        PLATFORM_PERMISSIONS.AGENT_CREATE,
        PLATFORM_PERMISSIONS.AGENT_PUBLISH,
        PLATFORM_PERMISSIONS.AGENT_ASSIGN,
      ];
      mocks.defaultAgent = defaultAgentState({ data: null, error: new Error('offline') });
      mocks.provisionDefaultInbox.mockResolvedValue({ identity: { id: 'agent-new' } });
      renderPage();

      // The write is idempotent server side, so a stale read is no reason to leave the platform
      // without a default assistant — and the failed read keeps its own retry.
      await waitFor(() => expect(mocks.provisionDefaultInbox).toHaveBeenCalledOnce());
      expect(screen.getByText('agentCatalog.defaultAgent.loadError')).toBeTruthy();
      fireEvent.click(screen.getByText('agentCatalog.dependency.retry'));
      expect(mocks.defaultAgentMutate).toHaveBeenCalled();
    });
  });
});
