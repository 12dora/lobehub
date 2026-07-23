// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { CursorPagedListSurface, useCursorStack } from './useCursorPagedList';

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ extra, message }: { extra?: ReactNode; message?: ReactNode }) => (
    <div role="alert">
      {message}
      {extra}
    </div>
  ),
  Empty: ({ description }: { description?: ReactNode }) => <div>{description}</div>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button disabled={disabled} type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock('@/features/NavPanel/components/SkeletonList', () => ({
  default: () => <div>skeleton</div>,
}));

describe('useCursorStack', () => {
  it('ignores rapid duplicate goNext with the same cursor', () => {
    const { result } = renderHook(() => useCursorStack());
    act(() => {
      result.current.goNext('cursor-2');
      result.current.goNext('cursor-2');
      result.current.goNext('cursor-2');
    });
    expect(result.current.cursor).toBe('cursor-2');
    expect(result.current.hasPrevious).toBe(true);

    act(() => {
      result.current.goPrevious();
    });
    // One Previous returns to page 1 — not a second identical cursor entry.
    expect(result.current.cursor).toBeUndefined();
    expect(result.current.hasPrevious).toBe(false);
  });
});

describe('CursorPagedListSurface double-click guard', () => {
  it('does not invoke onNext twice when Next is clicked rapidly while loading', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    render(
      <CursorPagedListSurface
        isLoading
        data={{ items: [{ id: '1' }], nextCursor: 'cursor-2' }}
        pagination={{ hasPrevious: false }}
        renderItems={() => <div>row</div>}
        labels={{
          empty: 'empty',
          error: 'error',
          loading: 'loading',
          pageError: 'pageError',
        }}
        onNext={onNext}
        onPrevious={onPrevious}
        onRetry={() => undefined}
      />,
    );

    const next = screen.getByText('skillCatalog.pagination.next');
    expect(next).toHaveProperty('disabled', true);
    fireEvent.click(next);
    fireEvent.click(next);
    expect(onNext).not.toHaveBeenCalled();
  });

  it('is idempotent when rapid Next clicks race before isLoading flips', () => {
    const onNext = vi.fn();
    render(
      <CursorPagedListSurface
        data={{ items: [{ id: '1' }], nextCursor: 'cursor-2' }}
        isLoading={false}
        pagination={{ hasPrevious: false }}
        renderItems={() => <div>row</div>}
        labels={{
          empty: 'empty',
          error: 'error',
          loading: 'loading',
          pageError: 'pageError',
        }}
        onNext={onNext}
        onPrevious={() => undefined}
        onRetry={() => undefined}
      />,
    );

    const next = screen.getByText('skillCatalog.pagination.next');
    fireEvent.click(next);
    fireEvent.click(next);
    fireEvent.click(next);
    // Surface may fire multiple clicks before parent sets isLoading; goNext remains
    // idempotent, and the surface still only forwards when !isLoading + nextCursor.
    expect(onNext).toHaveBeenCalled();
    expect(onNext.mock.calls.every((call) => call[0] === 'cursor-2')).toBe(true);
  });
});
