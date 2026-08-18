// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { motion } from 'motion/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import TaskTemplateListPage from './TaskTemplateListPage';

/**
 * The unit suite stubs the table to inspect the props the page hands it. This one renders the
 * REAL `DataTable` (antd Table) and the REAL sortable row, because the selection column's
 * position and the checkbox wiring are decided by antd itself: a placeholder column that antd
 * does not swap in place, or a `rowSelection` antd never calls, would look identical to a stub.
 */
const item = {
  category: 'engineering',
  connectors: [],
  cronPattern: '0 9 * * *',
  description: 'Daily digest',
  enabled: true,
  icon: null,
  id: 'tpl-1',
  identifier: 'daily-digest',
  instruction: 'Summarize',
  interests: [],
  revision: 3,
  sortOrder: 0,
  source: 'manual',
  title: 'Engineering digest',
  updatedAt: new Date('2026-08-16T00:00:00Z'),
};

const second = { ...item, id: 'tpl-2', revision: 5, title: 'Second digest' };

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

vi.mock('@/enterprise/client/services/adminTaskTemplates', () => ({
  adminTaskTemplatesService: {
    delete: vi.fn(),
    importRecommendations: vi.fn(),
    reorder: vi.fn(),
    setEnabled: vi.fn(),
  },
}));

vi.mock('./openTaskTemplateEditorModal', () => ({ openTaskTemplateEditorModal: vi.fn() }));

vi.mock('../primitives/DangerConfirm', () => ({ openDangerConfirm: vi.fn() }));

vi.mock('./useAdminTaskTemplates', () => ({
  refreshAdminTaskTemplateLists: () => mocks.refreshLists(),
  useFetchAdminTaskTemplates: () => ({
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
        <TaskTemplateListPage />
      </MemoryRouter>
    </MotionProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.data = { items: [item, second], totalAll: 2, totalFiltered: 2 };
});

describe('TaskTemplateListPage against the real DataTable', () => {
  it('renders the checkbox column right after the drag handle and wires the selection', async () => {
    renderPage();

    await waitFor(() => expect(bodyRows()).toHaveLength(2));

    const cells = Array.from(bodyRows()[0]!.querySelectorAll('td'));
    // The grip stays first, the checkbox antd would have prepended lands behind it.
    expect(
      cells[0]!.querySelector('button[aria-label^="taskTemplateCatalog.list.dragHandle"]'),
    ).toBeTruthy();
    const checkbox = cells[1]!.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).toBeTruthy();
    expect(cells[2]!.textContent).toContain('Engineering digest');

    expect(screen.queryByText(/taskTemplateCatalog\.list\.selectedCount/)).toBeNull();

    fireEvent.click(checkbox!);

    // antd's own onChange reached the selection hook, so the toolbar counts the row.
    await waitFor(() =>
      expect(screen.getByText('taskTemplateCatalog.list.selectedCount:1')).toBeTruthy(),
    );
    expect(screen.getByText('taskTemplateCatalog.list.bulk.delete')).toBeTruthy();
  });
});
