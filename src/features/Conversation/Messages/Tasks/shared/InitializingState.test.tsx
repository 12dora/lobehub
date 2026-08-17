import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import InitializingState from './InitializingState';

const setDocumentHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
};

describe('InitializingState timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDocumentHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setDocumentHidden(false);
  });

  it('ticks the elapsed counter every second while visible', () => {
    render(<InitializingState />);

    expect(screen.getByText('(0:00)')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByText('(0:03)')).toBeInTheDocument();
  });

  it('does not re-render the counter while the tab is hidden', () => {
    render(<InitializingState />);
    setDocumentHidden(true);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByText('(0:00)')).toBeInTheDocument();

    setDocumentHidden(false);
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // resyncs against wall clock, not against the ticks it skipped
    expect(screen.getByText('(0:06)')).toBeInTheDocument();
  });

  it('clears the interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const { unmount } = render(<InitializingState />);
    const created = setIntervalSpy.mock.results.map((result) => result.value);
    expect(created.length).toBe(1);

    unmount();

    expect(clearIntervalSpy.mock.calls.map((call) => call[0])).toContain(created[0]);
  });
});
