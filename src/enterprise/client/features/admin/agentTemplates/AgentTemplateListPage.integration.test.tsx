// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { motion } from 'motion/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import AgentTemplateListPage from './AgentTemplateListPage';

/**
 * The unit suite stubs the table to inspect the props the page hands it. This one renders the
 * REAL `DataTable` (antd Table) and the REAL sortable row, because the selection column's
 * position and the checkbox wiring are decided by antd itself: a placeholder column that antd
 * does not swap in place, or a `rowSelection` antd never calls, would look identical to a stub.
 */
const item = {
  avatar: null,
  backgroundColor: null,
  description: 'Turns raw numbers into a weekly brief',
  enabled: true,
  id: 'tpl-1',
  identifier: 'data-analyst',
  revision: 3,
  sortOrder: 0,
  source: 'manual',
  systemRole: 'You are a data analyst.',
  tags: [],
  title: 'Data analyst',
  updatedAt: new Date('2026-08-16T00:00:00Z'),
};

const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second analyst' };

const mocks = vi.hoisted(() => ({
  data: undefined as unknown,
  refreshLists: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US', resolvedLanguage: 'en-US' },
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: null,
    permissions: [
      PLATFORM_PERMISSIONS.AGENT_READ,
      PLATFORM_PERMISSIONS.AGENT_CREATE,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_DELETE,
    ],
  }),
}));

vi.mock('@/enterprise/client/services/adminAgentTemplates', () => ({
  adminAgentTemplatesService: {
    delete: vi.fn(),
    importBuiltins: vi.fn(),
    reorder: vi.fn(),
    setEnabled: vi.fn(),
  },
}));

vi.mock('./openAgentTemplateEditorModal', () => ({ openAgentTemplateEditorModal: vi.fn() }));

vi.mock('../primitives/DangerConfirm', () => ({ openDangerConfirm: vi.fn() }));

vi.mock('./useAdminAgentTemplates', () => ({
  refreshAdminAgentTemplateLists: () => mocks.refreshLists(),
  useFetchAdminAgentTemplates: () => ({
    data: mocks.data,
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => <div role="status">loading</div>,
}));

const bodyRows = () =>
  Array.from(document.querySelectorAll<HTMLTableRowElement>('tbody tr.ant-table-row'));

// The app mounts MotionProvider globally; the real @lobehub/ui buttons require it.
const renderPage = () =>
  render(
    <MotionProvider motion={motion}>
      <MemoryRouter>
        <AgentTemplateListPage />
      </MemoryRouter>
    </MotionProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = { items: [item, second], totalAll: 2, totalFiltered: 2 };
});

describe('AgentTemplateListPage against the real DataTable', () => {
  it('renders the checkbox column right after the drag handle and wires the selection', async () => {
    renderPage();

    await waitFor(() => expect(bodyRows()).toHaveLength(2));

    const cells = Array.from(bodyRows()[0]!.querySelectorAll('td'));
    // The grip stays first, the checkbox antd would have prepended lands behind it.
    expect(
      cells[0]!.querySelector('button[aria-label^="agentTemplateCatalog.list.dragHandle"]'),
    ).toBeTruthy();
    const checkbox = cells[1]!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    expect(cells[2]!.textContent).toContain('Data analyst');

    expect(screen.queryByText(/agentTemplateCatalog\.list\.selectedCount/)).toBeNull();

    fireEvent.click(checkbox!);

    // antd's own onChange reached the selection hook, so the toolbar counts the row.
    await waitFor(() =>
      expect(screen.getByText('agentTemplateCatalog.list.selectedCount:1')).toBeTruthy(),
    );
    expect(screen.getByText('agentTemplateCatalog.list.bulk.delete')).toBeTruthy();
  });
});
