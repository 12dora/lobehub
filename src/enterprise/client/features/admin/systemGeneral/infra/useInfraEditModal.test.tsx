// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useInfraEditModal } from './useInfraEditModal';

const mocks = vi.hoisted(() => ({ confirmModal: vi.fn() }));

vi.mock('@lobehub/ui/base-ui', () => ({
  confirmModal: (props: unknown) => mocks.confirmModal(props),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const setup = (dirty: boolean) => {
  const beginEdit = vi.fn();
  const cancelEdit = vi.fn();
  const rendered = renderHook(
    (props: { dirty: boolean; saveCount: number }) =>
      useInfraEditModal({
        beginEdit,
        cancelEdit,
        dirty: props.dirty,
        saveCount: props.saveCount,
      }),
    { initialProps: { dirty, saveCount: 0 } },
  );
  return { beginEdit, cancelEdit, ...rendered };
};

const confirmConfig = () =>
  mocks.confirmModal.mock.calls[0]![0] as { onOk: () => void; title: string };

beforeEach(() => {
  mocks.confirmModal.mockClear();
});

describe('useInfraEditModal', () => {
  it('seeds the draft when it opens and discards it on a clean close', () => {
    const { beginEdit, cancelEdit, result } = setup(false);

    act(() => result.current.onOpenChange(true));
    expect(beginEdit).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(true);

    act(() => result.current.onOpenChange(false));
    expect(mocks.confirmModal).not.toHaveBeenCalled();
    expect(cancelEdit).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(false);
  });

  it('asks before throwing an unsaved draft away, and keeps it until the answer comes', () => {
    const { cancelEdit, result } = setup(true);

    act(() => result.current.onOpenChange(true));
    act(() => result.current.onOpenChange(false));

    // The draft is still there and the modal is still open — nothing happens until 确认.
    expect(cancelEdit).not.toHaveBeenCalled();
    expect(result.current.open).toBe(true);
    expect(confirmConfig().title).toBe('systemGeneral.unsaved.title');

    act(() => confirmConfig().onOk());
    expect(cancelEdit).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(false);
  });

  it('guards the footer 取消 with the same question as the mask', () => {
    // The regression: the footer button used to call the setter directly, so 取消 was a second
    // door out of the modal that wiped the draft without asking.
    const { cancelEdit, result } = setup(true);

    act(() => result.current.onOpenChange(true));
    act(() => result.current.requestClose());

    expect(mocks.confirmModal).toHaveBeenCalledTimes(1);
    expect(cancelEdit).not.toHaveBeenCalled();
    expect(result.current.open).toBe(true);

    act(() => confirmConfig().onOk());
    expect(cancelEdit).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(false);
  });

  it('lets a clean footer 取消 through without a question', () => {
    const { cancelEdit, result } = setup(false);

    act(() => result.current.onOpenChange(true));
    act(() => result.current.requestClose());

    expect(mocks.confirmModal).not.toHaveBeenCalled();
    expect(cancelEdit).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(false);
  });

  it('closes on an accepted write without discarding what was just saved', () => {
    const { cancelEdit, rerender, result } = setup(true);

    act(() => result.current.onOpenChange(true));
    rerender({ dirty: false, saveCount: 1 });

    expect(result.current.open).toBe(false);
    expect(cancelEdit).not.toHaveBeenCalled();
    expect(mocks.confirmModal).not.toHaveBeenCalled();
  });

  it('follows the dirty flag, so a draft that became dirty after opening is still guarded', () => {
    const { cancelEdit, rerender, result } = setup(false);

    act(() => result.current.onOpenChange(true));
    rerender({ dirty: true, saveCount: 0 });
    act(() => result.current.requestClose());

    expect(mocks.confirmModal).toHaveBeenCalledTimes(1);
    expect(cancelEdit).not.toHaveBeenCalled();
  });
});
