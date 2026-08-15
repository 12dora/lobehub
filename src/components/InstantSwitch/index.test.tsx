// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import InstantSwitch from './index';

const isChecked = () => screen.getByRole('switch').getAttribute('aria-checked') === 'true';

describe('InstantSwitch', () => {
  it('follows an external change of `enabled` (e.g. the provider was disabled by another flow)', () => {
    const { rerender } = render(<InstantSwitch enabled={true} onChange={async () => {}} />);
    expect(isChecked()).toBe(true);

    rerender(<InstantSwitch enabled={false} onChange={async () => {}} />);
    expect(isChecked()).toBe(false);
  });

  it('keeps the optimistic value while the write is in flight and rolls back on failure', async () => {
    let reject!: (error: Error) => void;
    const onChange = vi.fn(
      () =>
        new Promise<void>((_, r) => {
          reject = r;
        }),
    );
    const { rerender } = render(<InstantSwitch enabled={false} onChange={onChange} />);

    await act(async () => {
      screen.getByRole('switch').click();
    });
    expect(isChecked()).toBe(true);

    // A stale re-render with the old prop must not clobber the optimistic value mid-flight.
    rerender(<InstantSwitch enabled={false} onChange={onChange} />);
    expect(isChecked()).toBe(true);

    await act(async () => {
      reject(new Error('write failed'));
    });
    expect(isChecked()).toBe(false);
  });
});
