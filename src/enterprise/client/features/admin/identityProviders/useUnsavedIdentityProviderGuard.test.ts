import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUnsavedIdentityProviderGuard } from './useUnsavedIdentityProviderGuard';

const mocks = vi.hoisted(() => ({
  blocker: { proceed: vi.fn(), reset: vi.fn(), state: 'unblocked' },
  confirmModal: vi.fn((_options: { onCancel: () => void; onOk: () => void }) => ({
    close: vi.fn(),
    destroy: vi.fn(),
  })),
}));

vi.mock('@lobehub/ui/base-ui', () => ({ confirmModal: mocks.confirmModal }));
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
    const options = mocks.confirmModal.mock.calls[0]![0];

    act(() => options.onCancel());
    expect(mocks.blocker.reset).toHaveBeenCalledOnce();
    expect(mocks.blocker.proceed).not.toHaveBeenCalled();

    mocks.blocker.state = 'blocked';
    renderHook(() => useUnsavedIdentityProviderGuard(true));
    act(() => mocks.confirmModal.mock.calls[1]![0].onOk());
    expect(mocks.blocker.proceed).toHaveBeenCalledOnce();
  });
});
