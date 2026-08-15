// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import StatsUserFilterSelect from './StatsUserFilterSelect';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('antd-style', () => ({ cssVar: {} }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui', () => ({
  Avatar: () => null,
  Flexbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Icon: () => null,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  AutoComplete: ({
    onChange,
    onSearch,
    options,
    placeholder,
    value,
  }: {
    onChange?: (value: string) => void;
    onSearch?: (value: string) => void;
    options?: Array<{ label: ReactNode; value: string }>;
    placeholder?: string;
    value?: string;
  }) => {
    // Mirrors base-ui: ONE `onValueChange` fans the same string out to both callbacks,
    // in this order — typing gives the raw text, picking gives `option.value`.
    const emit = (next: string) => {
      onChange?.(next);
      onSearch?.(next);
    };
    return (
      <div>
        <input
          placeholder={placeholder}
          value={value ?? ''}
          onChange={(event) => emit(event.target.value)}
        />
        {(options ?? []).map((option) => (
          <button key={option.value} type="button" onClick={() => emit(option.value)}>
            {option.label}
          </button>
        ))}
      </div>
    );
  },
}));

vi.mock('@/enterprise/client/services/adminUsers', () => ({
  adminUsersService: { list: mocks.list },
}));

describe('StatsUserFilterSelect', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.list.mockReset().mockResolvedValue({
      items: [{ avatar: null, email: 'ada@example.com', fullName: 'Ada Lovelace', id: 'u1' }],
      nextCursor: null,
    });
  });

  const type = (text: string) =>
    fireEvent.change(screen.getByPlaceholderText('stats.userFilter.allUsers'), {
      target: { value: text },
    });

  it('debouncesTheSearchAndCommitsThePickedUserWithItsDisplayName', async () => {
    const onChange = vi.fn();
    render(<StatsUserFilterSelect onChange={onChange} />);

    type('ada');
    expect(mocks.list).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ limit: 20, query: 'ada' }));

    const option = await screen.findByRole('button', { name: /Ada Lovelace/ });
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith('u1', 'Ada Lovelace');

    // The selection must survive the second callback base-ui fires with the same value:
    // the input keeps the name (not the raw id) and no follow-up search is scheduled.
    const input = screen.getByPlaceholderText('stats.userFilter.allUsers') as HTMLInputElement;
    expect(input.value).toBe('Ada Lovelace');
    vi.advanceTimersByTime(500);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('clearingTheInputRestoresAllUsersWithoutAnotherRequest', async () => {
    const onChange = vi.fn();
    render(<StatsUserFilterSelect value={'u1'} valueLabel={'Ada Lovelace'} onChange={onChange} />);

    fireEvent.change(screen.getByPlaceholderText('stats.userFilter.allUsers'), {
      target: { value: '' },
    });

    expect(onChange).toHaveBeenCalledWith(undefined);
    vi.advanceTimersByTime(500);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('surfacesAHintWhenTheDirectoryLookupIsDeniedInsteadOfAnEmptyDropdown', async () => {
    mocks.list.mockRejectedValue(new Error('FORBIDDEN'));
    render(<StatsUserFilterSelect onChange={vi.fn()} />);

    type('ada');
    vi.advanceTimersByTime(300);

    expect(await screen.findByText('stats.userFilter.searchFailed')).toBeTruthy();
  });
});
