/**
 * Users list × slide-in detail, wired end to end: the REAL `DataTable` and the REAL
 * base-ui `Drawer` inside a router. Only the data seams (SWR / service / access) and
 * the detail body are doubled, so the panel's URL contract, open/close timing and
 * mount lifecycle are observed on the components that actually ship.
 *
 * @vitest-environment happy-dom
 */
import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { motion } from 'motion/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UsersListPage from './UsersListPage';

/**
 * Every committed body render, in order. A body derived through a passive effect
 * re-commits the outgoing user once more on an A → B switch; Testing Library
 * flushes effects before returning, so only this log can see it.
 */
const bodyRenders = vi.hoisted(() => [] as string[]);

const sampleList = {
  items: [
    {
      avatar: null,
      createdAt: new Date('2024-01-01'),
      dingtalkTitle: null,
      email: 'alice@example.com',
      fullName: 'Alice',
      id: 'u1',
      lastActiveAt: null,
      providerIds: ['credential'],
      roles: ['platform_user'],
      status: 'active' as const,
      username: 'alice',
    },
    {
      avatar: null,
      createdAt: new Date('2024-01-02'),
      dingtalkTitle: null,
      email: 'carol@example.com',
      fullName: 'Carol',
      id: 'u2',
      lastActiveAt: null,
      providerIds: ['corp-oidc'],
      roles: ['platform_user'],
      status: 'active' as const,
      username: 'carol',
    },
  ],
  nextCursor: null,
  total: 2,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolated names are appended so per-user labels stay distinguishable.
    t: (key: string, opts?: { defaultValue?: string; name?: string }) =>
      opts?.name != null ? `${key}:${opts.name}` : (opts?.defaultValue ?? key),
  }),
}));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: () => ({
    data: sampleList,
    error: undefined,
    isLoading: false,
    isValidating: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('@/enterprise/client/services/adminUsers', () => ({
  adminUsersService: { list: () => Promise.resolve(sampleList) },
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: 'better-auth',
    permissions: [] as string[],
    roles: [{ name: 'user_admin' }],
  }),
}));

vi.mock('@/store/user', () => ({
  useUserStore: (selector: (s: { user?: { id?: string } }) => unknown) =>
    selector({ user: { id: 'admin-self' } }),
}));

vi.mock('@/store/user/selectors', () => ({
  userProfileSelectors: { userId: (s: { user?: { id?: string } }) => s.user?.id },
}));

vi.mock('./detail/UserDetailBody', () => ({
  default: ({ userId }: { userId: string }) => {
    bodyRenders.push(userId);
    return (
      <div data-testid="detail-body" data-user-id={userId}>
        detail-of-{userId}
      </div>
    );
  },
}));

/** Reads the live URL and drives Back the way the browser button does. */
const RouterProbe = () => {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="location">{`${location.pathname}${location.search}`}</span>
      <button data-testid="go-back" type="button" onClick={() => void navigate(-1)}>
        back
      </button>
    </div>
  );
};

const renderPage = (entries: string[] = ['/admin/users']) =>
  render(
    <MotionProvider motion={motion}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <UsersListPage />
        <RouterProbe />
      </MemoryRouter>
    </MotionProvider>,
  );

const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-row-key="${id}"]`)!;

/** The row's Edit action — the only affordance that opens a user. */
const editButton = (container: HTMLElement, id: string) =>
  within(row(container, id)).getByText('users.list.actions.edit');

const openUser = (container: HTMLElement, id: string) => {
  fireEvent.click(editButton(container, id));
};

const bodyUserId = () => screen.getByTestId('detail-body').dataset.userId;

const location = () => screen.getByTestId('location').textContent;

const goBack = () => fireEvent.click(screen.getByTestId('go-back'));

const closeButton = () => screen.getByLabelText('users.detail.closePanel');

/** The panel slides out, so the dialog leaves the tree a few frames after the URL does. */
const waitForDrawerGone = () =>
  waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('detail-body')).toBeNull();
  });

describe('UsersListPage × UserDetailDrawer (real DataTable + real Drawer)', () => {
  beforeEach(() => {
    bodyRenders.length = 0;
  });

  it('opens the drawer with the body for the clicked user and writes ?user=', () => {
    const { container } = renderPage();
    expect(screen.queryByTestId('detail-body')).toBeNull();

    openUser(container, 'u1');

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(bodyUserId()).toBe('u1');
    expect(location()).toBe('/admin/users?user=u1');
  });

  it('closes on Back without leaving the list', async () => {
    const { container } = renderPage(['/admin', '/admin/users']);
    openUser(container, 'u1');
    expect(location()).toBe('/admin/users?user=u1');

    goBack();

    expect(location()).toBe('/admin/users');
    await waitForDrawerGone();
  });

  it('drops the param with replace on an explicit close, so Back does not reopen it', async () => {
    const { container } = renderPage(['/admin', '/admin/users']);
    openUser(container, 'u1');

    fireEvent.click(closeButton());
    expect(location()).toBe('/admin/users');

    // Replace (not push): closing consumed the entry the open had pushed, so Back
    // steps out of the list instead of re-opening the drawer.
    goBack();
    expect(location()).toBe('/admin/users');
    await waitForDrawerGone();

    goBack();
    expect(location()).toBe('/admin');
  });

  it('closes on Escape', async () => {
    const { container } = renderPage();
    openUser(container, 'u1');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(location()).toBe('/admin/users');
    await waitForDrawerGone();
  });

  it('shows the new user immediately when switching A → B (no stale body frame)', () => {
    const { container } = renderPage();
    openUser(container, 'u1');
    expect(bodyUserId()).toBe('u1');

    bodyRenders.length = 0;
    openUser(container, 'u2');

    // Asserted synchronously: a mirrored id would still be showing u1 here.
    expect(bodyUserId()).toBe('u2');
    // …and would have committed one more u1 frame on the way.
    expect(bodyRenders).toEqual(['u2']);
    expect(location()).toBe('/admin/users?user=u2');
  });

  it('renders a body on the first frame of a rapid close → reopen', () => {
    const { container } = renderPage();
    openUser(container, 'u1');
    fireEvent.click(closeButton());

    bodyRenders.length = 0;
    openUser(container, 'u2');

    expect(bodyUserId()).toBe('u2');
    expect(bodyRenders).toEqual(['u2']);
  });

  it('leaves the identity and email cells inert — only Edit opens a user', () => {
    const { container } = renderPage();
    const target = row(container, 'u2');

    // The cells that used to carry the open control are plain content again.
    expect(target.querySelectorAll('[role="button"][aria-label]')).toHaveLength(0);

    const cellWith = (text: string) =>
      [...target.querySelectorAll<HTMLElement>('.ant-table-cell')].find((cell) =>
        cell.textContent?.includes(text),
      )!;

    fireEvent.click(cellWith('Carol'));
    fireEvent.click(cellWith('carol@example.com'));

    expect(screen.queryByTestId('detail-body')).toBeNull();
    expect(location()).toBe('/admin/users');
  });

  it('unmounts the body only after the panel has finished sliding out', async () => {
    const { container } = renderPage();
    openUser(container, 'u1');

    fireEvent.click(closeButton());

    // Still mounted while the panel slides out — unmounting on the close tick would
    // blank the panel mid-animation.
    expect(bodyUserId()).toBe('u1');

    await waitForDrawerGone();
  });

  it('leaves rows non-clickable — only the Edit action opens a user', () => {
    const { container } = renderPage();

    const rows = container.querySelectorAll('.ant-table-row');
    expect(rows.length).toBe(2);
    for (const node of rows) {
      expect(node.getAttribute('role')).not.toBe('link');
      expect(node.className).not.toContain('admin-table-row-clickable');
    }

    fireEvent.click(row(container, 'u2'));
    expect(screen.queryByTestId('detail-body')).toBeNull();
    expect(location()).toBe('/admin/users');
  });

  it('restores the panel from a shared ?user= link', () => {
    renderPage(['/admin/users?user=u2']);
    expect(bodyUserId()).toBe('u2');
  });
});
