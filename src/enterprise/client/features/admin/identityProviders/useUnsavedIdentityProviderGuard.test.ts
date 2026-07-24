import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUnsavedIdentityProviderGuard } from './useUnsavedIdentityProviderGuard';

const mocks = vi.hoisted(() => {
  const createModal = vi.fn(
    (options: { content?: ReactNode; onOpenChange?: (open: boolean) => void }) => {
      const instance = {
        close: vi.fn(() => {
          options.onOpenChange?.(false);
        }),
        destroy: vi.fn(),
        setCanDismissByClickOutside: vi.fn(),
        update: vi.fn(),
      };
      return instance;
    },
  );
  return {
    blocker: { proceed: vi.fn(), reset: vi.fn(), state: 'unblocked' as string },
    createModal,
  };
});

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    onClick,
    type,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    type?: string;
  }) => createElement('button', { 'data-type': type, onClick, 'type': 'button' }, children),
  createModal: mocks.createModal,
  ModalFooter: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router', () => ({ useBlocker: () => mocks.blocker }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.blocker.state = 'unblocked';
});

describe('identity provider unsaved guard', () => {
  it('blocks browser unload only while a local draft is dirty', () => {
    const { rerender } = renderHook(({ dirty }) => useUnsavedIdentityProviderGuard(dirty), {
      initialProps: { dirty: true },
    });
    const dirtyEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyEvent);
    expect(dirtyEvent.defaultPrevented).toBe(true);

    rerender({ dirty: false });
    const cleanEvent = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(false);
  });

  it('keeps editing on cancel and leaves only after explicit discard', () => {
    mocks.blocker.state = 'blocked';
    renderHook(() => useUnsavedIdentityProviderGuard(true));
    const firstOptions = mocks.createModal.mock.calls[0]![0] as {
      content: ReactNode;
      onOpenChange?: (open: boolean) => void;
    };

    const stayView = render(createElement('div', null, firstOptions.content));
    fireEvent.click(screen.getByText('identityProviders.unsaved.stay'));
    expect(mocks.blocker.reset).toHaveBeenCalledOnce();
    expect(mocks.blocker.proceed).not.toHaveBeenCalled();
    stayView.unmount();

    mocks.blocker.state = 'blocked';
    mocks.blocker.reset.mockClear();
    mocks.blocker.proceed.mockClear();
    renderHook(() => useUnsavedIdentityProviderGuard(true));
    const leaveOptions = mocks.createModal.mock.calls.at(-1)![0] as {
      content: ReactNode;
    };
    const leaveView = render(createElement('div', null, leaveOptions.content));
    fireEvent.click(screen.getByText('identityProviders.unsaved.discard'));
    expect(mocks.blocker.proceed).toHaveBeenCalledOnce();
    expect(mocks.blocker.reset).not.toHaveBeenCalled();
    leaveView.unmount();
  });

  it('passive dismiss (Escape/close) resets the router blocker', () => {
    mocks.blocker.state = 'blocked';
    renderHook(() => useUnsavedIdentityProviderGuard(true));
    act(() => {
      (
        mocks.createModal.mock.calls[0]![0] as { onOpenChange?: (open: boolean) => void }
      ).onOpenChange?.(false);
    });
    expect(mocks.blocker.reset).toHaveBeenCalledOnce();
    expect(mocks.blocker.proceed).not.toHaveBeenCalled();
  });
});
