/**
 * Out-of-order remote search responses must not overwrite the latest query.
 * @vitest-environment happy-dom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AuditUserSearchSelect from './AuditUserSearchSelect';

const searchUsers = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: { defaultValue?: string; id?: string }) =>
      opts?.defaultValue ?? (opts?.id ? `${k}:${opts.id}` : k),
  }),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  AutoComplete: ({
    onChange,
    onSearch,
    options,
    value,
  }: {
    onChange?: (v: string) => void;
    onSearch?: (q: string) => void;
    options?: { label: string; value: string }[];
    value?: string;
  }) => (
    <div>
      <input
        data-testid="user-search-input"
        value={value ?? ''}
        onChange={(e) => {
          onChange?.(e.target.value);
          onSearch?.(e.target.value);
        }}
      />
      <ul data-testid="user-search-options">
        {(options ?? []).map((o) => (
          <li data-testid={`opt-${o.value}`} key={o.value}>
            {o.label}
          </li>
        ))}
      </ul>
    </div>
  ),
}));

vi.mock('@/enterprise/client/services/adminAudit', () => ({
  adminAuditService: {
    searchUsers: (...args: unknown[]) => searchUsers(...args),
  },
}));

describe('AuditUserSearchSelect request sequencing', () => {
  beforeEach(() => {
    searchUsers.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps only the latest query options when responses resolve out of order', async () => {
    const resolvers: Record<string, (v: unknown) => void> = {};

    searchUsers.mockImplementation(({ q }: { q: string }) => {
      return new Promise((resolve) => {
        resolvers[q] = resolve;
      });
    });

    render(<AuditUserSearchSelect enabled onChange={vi.fn()} />);

    const input = screen.getByTestId('user-search-input');
    fireEvent.change(input, { target: { value: 'alice' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    fireEvent.change(input, { target: { value: 'bob' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(searchUsers).toHaveBeenCalledTimes(2);

    // Bob resolves first, then stale Alice — only Bob must remain selectable.
    await act(async () => {
      resolvers.bob!({
        items: [{ email: 'bob@ex.com', id: 'user-bob', username: 'bob' }],
      });
    });
    expect(screen.getByTestId('opt-user-bob')).toBeTruthy();

    await act(async () => {
      resolvers.alice!({
        items: [{ email: 'alice@ex.com', id: 'user-alice', username: 'alice' }],
      });
    });

    expect(screen.getByTestId('opt-user-bob')).toBeTruthy();
    expect(screen.queryByTestId('opt-user-alice')).toBeNull();
  });

  it('does not request when enabled is false', async () => {
    render(<AuditUserSearchSelect enabled={false} onChange={vi.fn()} />);
    const input = screen.getByTestId('user-search-input');
    fireEvent.change(input, { target: { value: 'alice' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(searchUsers).not.toHaveBeenCalled();
    expect(screen.getByText(/userSearchNoPermission|No search permission/i)).toBeTruthy();
  });
});
