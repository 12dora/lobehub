/**
 * Slide-in host: stacks the shared detail body over the users list.
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { startTransition, Suspense, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UserDetailDrawer from './UserDetailDrawer';

/**
 * Committed frames, in order. The bug this file guards is a *timing* one — a body
 * that lags one render behind `userId` — and it is invisible to DOM snapshots
 * because Testing Library flushes effects before handing control back.
 */
const frames = vi.hoisted(() => ({
  body: [] as (string | null)[],
  drawer: [] as { hasBody: boolean; open: boolean }[],
}));

/**
 * Lets a test make the body suspend for one user, so a concurrent render can be
 * started and then abandoned without ever committing.
 */
const suspense = vi.hoisted(() => ({
  pending: null as Promise<void> | null,
  release: null as (() => void) | null,
  userId: null as string | null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

// The real Drawer keeps children mounted through the slide-out; the stub renders
// them unconditionally so the host's own mount/unmount timing stays observable.
vi.mock('@lobehub/ui/base-ui', () => ({
  Drawer: ({ afterOpenChange, children, onClose, open, placement, title, width }: any) => {
    frames.drawer.push({ hasBody: Boolean(children), open: Boolean(open) });
    return (
      <div
        data-open={String(Boolean(open))}
        data-placement={placement}
        data-testid="drawer"
        data-width={String(width)}
      >
        <div data-testid="drawer-title">{title}</div>
        <button type="button" onClick={onClose}>
          drawer-close
        </button>
        <button type="button" onClick={() => afterOpenChange?.(false)}>
          drawer-exit-complete
        </button>
        {children}
      </div>
    );
  },
}));

vi.mock('./UserDetailBody', () => ({
  default: ({ onDeleted, onDismiss, userId, variant }: any) => {
    if (suspense.userId === userId) {
      suspense.pending ??= new Promise<void>((resolve) => {
        suspense.release = () => {
          suspense.userId = null;
          resolve();
        };
      });
      throw suspense.pending;
    }
    frames.body.push(userId);
    return (
      <div data-testid="detail-body" data-user-id={userId} data-variant={variant}>
        <button type="button" onClick={onDeleted}>
          body-deleted
        </button>
        <button type="button" onClick={onDismiss}>
          body-dismiss
        </button>
      </div>
    );
  },
}));

describe('UserDetailDrawer', () => {
  beforeEach(() => {
    frames.body.length = 0;
    frames.drawer.length = 0;
    suspense.pending = null;
    suspense.release = null;
    suspense.userId = null;
  });

  it('renders no body while closed', () => {
    render(<UserDetailDrawer open={false} userId={null} onClose={vi.fn()} />);
    expect(screen.getByTestId('drawer').dataset.open).toBe('false');
    expect(screen.queryByTestId('detail-body')).toBeNull();
  });

  it('slides in from the right with the shared body for the selected user', () => {
    render(<UserDetailDrawer open userId="u-9" onClose={vi.fn()} />);

    const drawer = screen.getByTestId('drawer');
    expect(drawer.dataset.open).toBe('true');
    expect(drawer.dataset.placement).toBe('right');
    expect(drawer.dataset.width).toBe('min(760px, calc(100vw - 48px))');
    expect(screen.getByTestId('drawer-title').textContent).toBe('users.detail.title');

    const body = screen.getByTestId('detail-body');
    expect(body.dataset.userId).toBe('u-9');
    expect(body.dataset.variant).toBe('drawer');
  });

  it('keeps the body through the slide-out and drops it once the panel is hidden', () => {
    const { rerender } = render(<UserDetailDrawer open userId="u-9" onClose={vi.fn()} />);

    rerender(<UserDetailDrawer open={false} userId={null} onClose={vi.fn()} />);
    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-9');

    fireEvent.click(screen.getByText('drawer-exit-complete'));
    expect(screen.queryByTestId('detail-body')).toBeNull();
  });

  it('reopens with the new body on the first render after an exit', () => {
    const { rerender } = render(<UserDetailDrawer open userId="u-9" onClose={vi.fn()} />);

    rerender(<UserDetailDrawer open={false} userId={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('drawer-exit-complete'));
    expect(screen.queryByTestId('detail-body')).toBeNull();

    frames.drawer.length = 0;
    rerender(<UserDetailDrawer open userId="u-4" onClose={vi.fn()} />);
    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-4');
    // Not a single committed frame shows the panel open with an empty body.
    expect(frames.drawer.filter((frame) => frame.open && !frame.hasBody)).toEqual([]);
  });

  it('shows the new body immediately when switching users while open', () => {
    const { rerender } = render(<UserDetailDrawer open userId="u-9" onClose={vi.fn()} />);
    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-9');

    frames.body.length = 0;
    rerender(<UserDetailDrawer open userId="u-4" onClose={vi.fn()} />);

    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-4');
    // No frame re-commits the outgoing user while the new one is already selected.
    expect(frames.body).toEqual(['u-4']);
  });

  it('keeps the reopened body when a stale exit callback lands after reopening', () => {
    const { rerender } = render(<UserDetailDrawer open userId="u-9" onClose={vi.fn()} />);

    rerender(<UserDetailDrawer open={false} userId={null} onClose={vi.fn()} />);
    rerender(<UserDetailDrawer open userId="u-9" onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('drawer-exit-complete'));

    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-9');
  });

  it('never shows a user that only an abandoned concurrent render saw', async () => {
    let setPanel: (next: { open: boolean; userId: string | null }) => void = () => {};
    const Host = () => {
      const [panel, setState] = useState<{ open: boolean; userId: string | null }>({
        open: true,
        userId: 'u-9',
      });
      setPanel = setState;
      return (
        <Suspense fallback={<div data-testid="fallback" />}>
          <UserDetailDrawer open={panel.open} userId={panel.userId} onClose={vi.fn()} />
        </Suspense>
      );
    };

    render(<Host />);
    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-9');

    // u-4 is picked inside a transition and suspends: React renders the host with
    // u-4, throws the render away and keeps u-9 on screen.
    suspense.userId = 'u-4';
    await act(async () => {
      startTransition(() => setPanel({ open: true, userId: 'u-4' }));
    });
    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-9');

    // The operator closes before u-4 ever resolves. The exit must animate out the
    // committed user, not the one only the discarded render knew about.
    await act(async () => {
      setPanel({ open: false, userId: null });
    });
    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-9');

    // When u-4 finally settles React retries the work it threw away. A ref written
    // during that render would surface u-4 here — mid-exit, for a user that was
    // never committed and is no longer selected.
    await act(async () => {
      suspense.release?.();
    });
    expect(screen.getByTestId('detail-body').dataset.userId).toBe('u-9');

    fireEvent.click(screen.getByText('drawer-exit-complete'));
    expect(screen.queryByTestId('detail-body')).toBeNull();
  });

  it('closes from the drawer chrome, from a deleted user and from a terminal state', () => {
    const onClose = vi.fn();
    render(<UserDetailDrawer open userId="u-9" onClose={onClose} />);

    fireEvent.click(screen.getByText('drawer-close'));
    fireEvent.click(screen.getByText('body-deleted'));
    fireEvent.click(screen.getByText('body-dismiss'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
