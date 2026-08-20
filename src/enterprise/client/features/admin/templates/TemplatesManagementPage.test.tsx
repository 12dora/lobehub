// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import TemplatesManagementPage from './TemplatesManagementPage';

let searchParams = new URLSearchParams();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', () => ({
  useSearchParams: () => [
    searchParams,
    (next: URLSearchParams) => {
      searchParams = next;
    },
  ],
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Tabs: ({
    activeKey,
    items,
    onChange,
  }: {
    activeKey: string;
    items: { key: string; label: string }[];
    onChange: (key: string) => void;
  }) => (
    <div data-active={activeKey} role="tablist">
      {items.map((item) => (
        <button key={item.key} role="tab" type="button" onClick={() => onChange(item.key)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../taskTemplates/TaskTemplateListPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-embedded={String(Boolean(embedded))}>task-templates-body</div>
  ),
}));

vi.mock('../agentTemplates/AgentTemplateListPage', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-embedded={String(Boolean(embedded))}>agent-templates-body</div>
  ),
}));

const activeTab = () => screen.getByRole('tablist').dataset.active;
const tabLabels = () => screen.queryAllByRole('tab').map((node) => node.textContent);

beforeEach(() => {
  searchParams = new URLSearchParams();
});

describe('TemplatesManagementPage', () => {
  it('offers both template catalogs as tabs, 任务模板 first', () => {
    render(<TemplatesManagementPage />);

    expect(tabLabels()).toEqual(['templates.tabs.tasks', 'templates.tabs.agents']);
  });

  it('lands on 任务模板 by default — the path used to be that page', () => {
    render(<TemplatesManagementPage />);

    expect(activeTab()).toBe('tasks');
    expect(screen.getByText('task-templates-body')).toBeTruthy();
    expect(screen.queryByText('agent-templates-body')).toBeNull();
  });

  it('opens 助理模板 from ?tab=agents', () => {
    searchParams = new URLSearchParams('tab=agents');
    render(<TemplatesManagementPage />);

    expect(activeTab()).toBe('agents');
    expect(screen.getByText('agent-templates-body')).toBeTruthy();
    expect(screen.queryByText('task-templates-body')).toBeNull();
  });

  it('falls back to 任务模板 for an unknown ?tab= value instead of rendering nothing', () => {
    searchParams = new URLSearchParams('tab=nope');
    render(<TemplatesManagementPage />);

    expect(activeTab()).toBe('tasks');
    expect(screen.getByText('task-templates-body')).toBeTruthy();
  });

  it('writes the picked tab into ?tab= so the surface is deep-linkable', () => {
    render(<TemplatesManagementPage />);

    fireEvent.click(screen.getByText('templates.tabs.agents'));

    expect(searchParams.get('tab')).toBe('agents');
  });

  it('renders both sub-pages embedded so the tab label is the only heading', () => {
    const { unmount } = render(<TemplatesManagementPage />);
    expect(screen.getByText('task-templates-body').dataset.embedded).toBe('true');
    unmount();

    searchParams = new URLSearchParams('tab=agents');
    render(<TemplatesManagementPage />);
    expect(screen.getByText('agent-templates-body').dataset.embedded).toBe('true');
  });
});
