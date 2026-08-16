// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import ContentModerationPage from './ContentModerationPage';

const mocks = vi.hoisted(() => ({
  admin: { authMethod: 'better-auth', permissions: [] as string[], status: 'allowed' },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
    <div>
      {items.map((item) => (
        <button
          data-active={item.key === activeKey}
          data-testid={`tab-${item.key}`}
          key={item.key}
          type="button"
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => mocks.admin,
}));

vi.mock('../primitives/AdminPageTemplate', () => ({
  default: ({
    children,
    title,
    toolbar,
  }: {
    children?: ReactNode;
    title?: ReactNode;
    toolbar?: ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      {toolbar}
      {children}
    </div>
  ),
}));

vi.mock('./overview/OverviewTab', () => ({
  default: ({ onOpenRecordsForUser }: { onOpenRecordsForUser: (id: string) => void }) => (
    <div data-testid="tab-body-overview">
      <button type="button" onClick={() => onOpenRecordsForUser('user-7')}>
        jump
      </button>
    </div>
  ),
}));
vi.mock('./records/RecordsTab', () => ({
  default: ({ canManage }: { canManage: boolean }) => (
    <div data-can-manage={String(canManage)} data-testid="tab-body-records" />
  ),
}));
vi.mock('./settings/SettingsTab', () => ({
  default: () => <div data-testid="tab-body-settings" />,
}));

const renderAt = (path: string) => {
  const router = createMemoryRouter(
    [{ element: <ContentModerationPage />, path: '/admin/audit/content-moderation' }],
    { initialEntries: [path] },
  );
  return { ...render(<RouterProvider router={router} />), router };
};

beforeEach(() => {
  mocks.admin.permissions = [PLATFORM_PERMISSIONS.MODERATION_READ];
});

describe('ContentModerationPage', () => {
  it('renders the three tabs and defaults to 概况', () => {
    renderAt('/admin/audit/content-moderation');
    expect(screen.getByTestId('tab-overview')).toBeTruthy();
    expect(screen.getByTestId('tab-records')).toBeTruthy();
    expect(screen.getByTestId('tab-settings')).toBeTruthy();
    expect(screen.getByTestId('tab-body-overview')).toBeTruthy();
  });

  it('honours ?tab= on entry', () => {
    renderAt('/admin/audit/content-moderation?tab=settings');
    expect(screen.getByTestId('tab-body-settings')).toBeTruthy();
    expect(screen.queryByTestId('tab-body-overview')).toBeNull();
  });

  it('falls back to 概况 for an unknown tab value', () => {
    renderAt('/admin/audit/content-moderation?tab=nope');
    expect(screen.getByTestId('tab-body-overview')).toBeTruthy();
  });

  it('switches tab through the URL so the view is shareable', () => {
    renderAt('/admin/audit/content-moderation');
    fireEvent.click(screen.getByTestId('tab-records'));
    expect(screen.getByTestId('tab-body-records')).toBeTruthy();
  });

  it('deep-links a chart click into the record list filtered by that user', () => {
    const { router } = renderAt('/admin/audit/content-moderation');
    fireEvent.click(screen.getByText('jump'));
    expect(screen.getByTestId('tab-body-records')).toBeTruthy();
    const search = new URLSearchParams(router.state.location.search);
    expect(search.get('tab')).toBe('records');
    expect(search.get('userId')).toBe('user-7');
  });

  it('clears a stale recordId when drilling into a different user', () => {
    const { router } = renderAt('/admin/audit/content-moderation?recordId=rec-old');
    fireEvent.click(screen.getByText('jump'));
    expect(new URLSearchParams(router.state.location.search).get('recordId')).toBeNull();
  });

  it('writes the active tab into the URL', () => {
    const { router } = renderAt('/admin/audit/content-moderation');
    fireEvent.click(screen.getByTestId('tab-settings'));
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBe('settings');
  });

  it('gates write controls on MODERATION_MANAGE', () => {
    renderAt('/admin/audit/content-moderation?tab=records');
    expect(screen.getByTestId('tab-body-records').dataset.canManage).toBe('false');
  });

  it('grants write controls when the manage permission is present', () => {
    mocks.admin.permissions = [
      PLATFORM_PERMISSIONS.MODERATION_READ,
      PLATFORM_PERMISSIONS.MODERATION_MANAGE,
    ];
    renderAt('/admin/audit/content-moderation?tab=records');
    expect(screen.getByTestId('tab-body-records').dataset.canManage).toBe('true');
  });

  it('shows the forbidden surface without MODERATION_READ', () => {
    mocks.admin.permissions = [];
    renderAt('/admin/audit/content-moderation');
    expect(screen.getByText('page.forbidden.desc')).toBeTruthy();
    expect(screen.queryByTestId('tab-overview')).toBeNull();
  });
});
