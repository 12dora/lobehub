/**
 * Slide-in host: stacks the shared detail body over the users list.
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { startTransition, Suspense, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UserDetailDrawer, { resolveUserPanelMotion } from './UserDetailDrawer';

/**
 * Committed frames, in order. The bug this file guards is a *timing* one — a body
 * that lags one render behind `userId` — and it is invisible to DOM snapshots
 * because Testing Library flushes effects before handing control back.
 */
const frames = vi.hoisted(() => ({
  body: [] as (string | null)[],
  drawer: [] as { hasBody: boolean; open: boolean }[],
  /** motionProps handed to DrawerPopup — must slow the library default down. */
  motion: null as any,
  /** popup className handed to DrawerPopup — carries the clip fix. */
  popupClassName: null as string | null | undefined,
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

// The host is composed from the Drawer atoms; the stubs keep children mounted
// unconditionally so the host's own mount/unmount timing stays observable, and record
// the props that carry the two fixes (popup clip class, motion overrides).
vi.mock('@lobehub/ui/base-ui', () => {
  const Ctx = {
    onExitComplete: null as null | (() => void),
    onOpenChange: null as any,
    open: false,
  };
  return {
    DrawerBackdrop: () => null,
    DrawerClose: (props: any) => (
      <button
        type="button"
        onClick={() => Ctx.onOpenChange?.(false, { reason: 'close-press' })}
        {...props}
      >
        drawer-close
      </button>
    ),
    // `children` is the host's body wrapper; its own child is the UserDetailBody (or null).
    DrawerContent: ({ children }: any) => {
      frames.drawer.push({ hasBody: Boolean(children?.props?.children), open: Ctx.open });
      return <div>{children}</div>;
    },
    DrawerHeader: ({ children }: any) => <div>{children}</div>,
    DrawerPopup: ({ children, className, motionProps, placement, popupStyle, width }: any) => {
      frames.popupClassName = className;
      frames.motion = motionProps;
      return (
        <div
          data-open={String(Ctx.open)}
          data-placement={placement}
          data-popup-width={popupStyle?.width}
          data-testid="drawer"
          data-width={String(width)}
        >
          <button type="button" onClick={() => Ctx.onExitComplete?.()}>
            drawer-exit-complete
          </button>
          {children}
        </div>
      );
    },
    DrawerPortal: ({ children }: any) => <>{children}</>,
    DrawerRoot: ({ children, onExitComplete, onOpenChange, open }: any) => {
      Ctx.onExitComplete = onExitComplete;
      Ctx.onOpenChange = onOpenChange;
      Ctx.open = Boolean(open);
      return <>{children}</>;
    },
    DrawerTitle: ({ children }: any) => <div data-testid="drawer-title">{children}</div>,
  };
});

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
    frames.popupClassName = null;
    frames.motion = null;
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
    expect(drawer.dataset.width).toBe('min(560px, calc(100vw - 48px))');
    expect(drawer.dataset.popupWidth).toBe('calc(min(560px, calc(100vw - 48px)) + 48px)');
    expect(screen.getByTestId('drawer-title').textContent).toBe('users.detail.title');

    const body = screen.getByTestId('detail-body');
    expect(body.dataset.userId).toBe('u-9');
    expect(body.dataset.variant).toBe('drawer');
  });

  /**
   * `body` carries `transform: translateZ(0)` app-wide, so it is the containing block of
   * the popup's fixed box: an unclipped popup lets the entering panel (translateX(100%))
   * extend `body.scrollWidth`, and the focus trap then scrolls the whole page sideways.
   * The class clips it. Real proof is the Playwright probe on the demo; this only guards
   * the wiring.
   */
  it('clips the popup wrapper so the entering panel cannot scroll the page', () => {
    render(<UserDetailDrawer open userId="u-9" onClose={vi.fn()} />);

    expect(typeof frames.popupClassName).toBe('string');
    expect(frames.popupClassName).toBeTruthy();
  });

  it('slows the slide down to an easing enter and a shorter exit, and collapses under reduced motion', () => {
    render(<UserDetailDrawer open userId="u-9" onClose={vi.fn()} />);
    expect(frames.motion.transition.duration).toBeGreaterThanOrEqual(0.4);
    expect(frames.motion.exit.transition.duration).toBeGreaterThanOrEqual(0.3);
    expect(frames.motion.exit.transition.duration).toBeLessThan(frames.motion.transition.duration);
    expect(frames.motion.exit.x).toBe('100%');

    expect(resolveUserPanelMotion(true).transition.duration).toBe(0);
    expect(resolveUserPanelMotion(true).exit.transition.duration).toBe(0);
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
