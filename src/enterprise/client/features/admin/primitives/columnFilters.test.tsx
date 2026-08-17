/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type { FilterDropdownProps } from 'antd/es/table/interface';
import type { Key, ReactNode } from 'react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  dateRangeColumnFilter,
  enumColumnFilter,
  firstColumnFilterValue,
  searchColumnFilter,
} from './columnFilters';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@lobehub/ui/base-ui', async () => {
  const React = await import('react');
  return {
    Button: ({ children, ...rest }: any) => React.createElement('button', rest, children),
    Input: ({ value, onChange, onKeyDown, placeholder }: any) =>
      React.createElement('input', {
        'data-testid': 'column-search',
        onChange,
        onKeyDown,
        placeholder,
        value,
      }),
  };
});

vi.mock('antd', () => ({
  DatePicker: {
    RangePicker: ({
      onChange,
      value,
    }: {
      onChange?: (
        next: Array<{ format: (f: string) => string; toDate: () => Date } | null> | null,
      ) => void;
      value?: Array<{ format: (f: string) => string; toDate: () => Date } | null>;
    }) => (
      <div>
        <span data-from={value?.[0]?.format('YYYY-MM-DD') ?? ''} data-testid="range-value" />
        <button
          type="button"
          onClick={() =>
            onChange?.([
              {
                format: () => '2026-01-01',
                toDate: () => new Date('2026-01-01T00:00:00.000Z'),
              },
              {
                format: () => '2026-01-31',
                toDate: () => new Date('2026-01-31T00:00:00.000Z'),
              },
            ])
          }
        >
          pick-range
        </button>
        <button type="button" onClick={() => onChange?.(null)}>
          clear-range
        </button>
      </div>
    ),
  },
}));

const dropdownProps = (overrides: Partial<FilterDropdownProps> = {}): FilterDropdownProps => ({
  clearFilters: vi.fn(),
  close: vi.fn(),
  confirm: vi.fn(),
  prefixCls: 'test',
  selectedKeys: [],
  setSelectedKeys: vi.fn(),
  visible: true,
  ...overrides,
});

describe('enumColumnFilter', () => {
  it('returns controlled antd filter props', () => {
    const props = enumColumnFilter({
      options: [
        { label: 'Active', value: 'active' },
        { label: 'Banned', value: 'banned' },
      ],
      value: 'active',
    });

    expect(props.filterMultiple).toBe(false);
    expect(props.filteredValue).toEqual(['active']);
    expect(props.filters).toEqual([
      { text: 'Active', value: 'active' },
      { text: 'Banned', value: 'banned' },
    ]);
  });

  it('keeps an empty selection controlled as null', () => {
    expect(enumColumnFilter({ options: [], value: [] }).filteredValue).toBeNull();
    expect(enumColumnFilter({ options: [], multiple: true }).filteredValue).toBeNull();
  });
});

describe('searchColumnFilter', () => {
  const SearchHarness = ({
    confirm,
    onSearch,
    value,
  }: {
    confirm: FilterDropdownProps['confirm'];
    onSearch: (next: string) => void;
    value?: string;
  }) => {
    const [selectedKeys, setSelectedKeys] = useState<Key[]>(value ? [value] : []);
    const column = searchColumnFilter({ onSearch, value });
    const dropdown = column.filterDropdown as (props: FilterDropdownProps) => ReactNode;

    return (
      <>
        {dropdown(
          dropdownProps({
            confirm,
            selectedKeys,
            setSelectedKeys,
          }),
        )}
        <span data-testid="filtered">{JSON.stringify(column.filteredValue)}</span>
      </>
    );
  };

  it('keeps filteredValue controlled and highlights an active query', () => {
    const column = searchColumnFilter({ onSearch: vi.fn(), value: 'alice' });
    expect(column.filteredValue).toEqual(['alice']);
    expect(column.filterOnClose).toBe(false);

    const icon = column.filterIcon as (filtered: boolean) => ReactNode;
    const { container } = render(<>{icon(true)}</>);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('applies the draft on Enter and Search, and resets to empty', () => {
    const onSearch = vi.fn();
    const confirm = vi.fn();

    render(<SearchHarness confirm={confirm} value="" onSearch={onSearch} />);

    fireEvent.change(screen.getByTestId('column-search'), { target: { value: 'alice' } });
    fireEvent.keyDown(screen.getByTestId('column-search'), { key: 'Enter' });

    expect(onSearch).toHaveBeenCalledWith('alice');
    expect(confirm).toHaveBeenCalledWith({ closeDropdown: true });

    fireEvent.click(screen.getByRole('button', { name: 'primitives.columnFilter.reset' }));
    expect(onSearch).toHaveBeenLastCalledWith('');
  });
});

describe('dateRangeColumnFilter', () => {
  const RangeHarness = ({
    confirm,
    onChange,
    value,
  }: {
    confirm: FilterDropdownProps['confirm'];
    onChange: (next: [Date | null, Date | null] | null) => void;
    value?: [Date | null, Date | null] | null;
  }) => {
    const column = dateRangeColumnFilter({ onChange, value });
    const dropdown = column.filterDropdown as (props: FilterDropdownProps) => ReactNode;

    return (
      <>
        {dropdown(dropdownProps({ confirm }))}
        <span data-testid="filtered">{JSON.stringify(column.filteredValue)}</span>
      </>
    );
  };

  it('serializes a controlled range into filteredValue', () => {
    const column = dateRangeColumnFilter({
      onChange: vi.fn(),
      value: [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-31T00:00:00.000Z')],
    });

    expect(column.filteredValue).toEqual(['2026-01-01', '2026-01-31']);
    expect(dateRangeColumnFilter({ onChange: vi.fn() }).filteredValue).toBeNull();
  });

  it('commits the picked range on Apply and clears on Reset', () => {
    const onChange = vi.fn();
    const confirm = vi.fn();

    render(<RangeHarness confirm={confirm} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'pick-range' }));
    fireEvent.click(screen.getByRole('button', { name: 'primitives.columnFilter.apply' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const applied = onChange.mock.calls[0]![0] as [Date | null, Date | null];
    expect(applied[0]?.toISOString().startsWith('2026-01-01')).toBe(true);
    expect(applied[1]?.toISOString().startsWith('2026-01-31')).toBe(true);
    expect(confirm).toHaveBeenCalledWith({ closeDropdown: true });

    fireEvent.click(screen.getByRole('button', { name: 'primitives.columnFilter.reset' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('firstColumnFilterValue', () => {
  it('collapses empty payloads to undefined', () => {
    expect(firstColumnFilterValue(undefined)).toBeUndefined();
    expect(firstColumnFilterValue([])).toBeUndefined();
    expect(firstColumnFilterValue([''])).toBeUndefined();
  });

  it('returns the first entry of a multi-value filter', () => {
    expect(firstColumnFilterValue(['a', 'b'])).toBe('a');
  });

  it('stringifies a non-array value', () => {
    expect(firstColumnFilterValue(12 as never)).toBe('12');
  });
});
