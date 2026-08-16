/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { dateRangeColumnFilter, enumColumnFilter, searchColumnFilter } from './columnFilters';
import DataTable from './DataTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const catalog: Record<string, string> = {
        'primitives.columnFilter.apply': 'Apply',
        'primitives.columnFilter.placeholder': 'Search',
        'primitives.columnFilter.reset': 'Reset',
        'primitives.columnFilter.search': 'Search',
        'primitives.dataTable.itemsPerPage': '/ page',
        'primitives.dataTable.pageSizeOption': '{{count}} / page',
        'primitives.dataTable.showTotal': '{{total}} items',
      };
      let text = catalog[key] ?? key;
      if (options) {
        for (const [name, value] of Object.entries(options)) {
          text = text.replaceAll(`{{${name}}}`, String(value));
        }
      }
      return text;
    },
  }),
}));

vi.mock('@lobehub/ui', async () => {
  const React = await import('react');
  return {
    Empty: ({ description }: any) => React.createElement('div', null, description),
    Flexbox: ({ children }: any) => React.createElement('div', null, children),
  };
});

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
    Select: ({ value, onChange, options, 'aria-label': aria }: any) =>
      React.createElement(
        'select',
        {
          'aria-label': aria,
          value,
          'onChange': (event: any) => onChange?.(event.target.value),
        },
        (options ?? []).map((option: any) =>
          React.createElement('option', { key: option.value, value: option.value }, option.label),
        ),
      ),
  };
});

vi.mock('antd', async (importOriginal) => {
  const React = await import('react');
  const actual = await importOriginal<Record<string, any>>();
  const RangePicker = ({
    onChange,
  }: {
    onChange?: (next: Array<{ toDate: () => Date } | null> | null) => void;
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: () =>
          onChange?.([
            { toDate: () => new Date(2026, 0, 1) },
            { toDate: () => new Date(2026, 0, 31) },
          ]),
      },
      'pick-range',
    );
  const DatePicker = Object.assign((props: any) => actual.DatePicker(props), {
    ...actual.DatePicker,
    RangePicker,
  });
  return { ...actual, DatePicker };
});

vi.mock('@/components/NeuralNetworkLoading', () => ({ default: () => null }));

type Row = { created: string; id: string; name: string; status: string };

const rows: Row[] = [
  { created: '2026-01-10', id: '1', name: 'Alice', status: 'active' },
  { created: '2026-01-12', id: '2', name: 'Bob', status: 'banned' },
];

const openColumnFilter = (container: HTMLElement, title: string) => {
  const header = [...container.querySelectorAll('th')].find((cell) =>
    cell.textContent?.includes(title),
  );
  const trigger = header?.querySelector('.ant-table-filter-trigger');
  expect(trigger).toBeTruthy();
  fireEvent.click(trigger!);
  return trigger as HTMLElement;
};

describe('DataTable column-filter contract', () => {
  it('enum header filter commits through onChange and clears when filteredValue resets', async () => {
    const onChange = vi.fn();
    const columnsFor = (value?: string) => [
      {
        dataIndex: 'status',
        key: 'status',
        title: 'Status',
        ...enumColumnFilter({
          options: [
            { label: 'Active', value: 'active' },
            { label: 'Banned', value: 'banned' },
          ],
          value,
        }),
      },
    ];

    const { container, rerender } = render(
      <DataTable
        columns={columnsFor()}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );

    openColumnFilter(container, 'Status');
    fireEvent.click(await screen.findByText('Active'));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    expect(onChange.mock.calls.at(-1)![0].filters).toMatchObject({ status: ['active'] });

    rerender(
      <DataTable
        columns={columnsFor('active')}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );
    expect(container.querySelector('.ant-table-filter-trigger.active')).toBeTruthy();

    rerender(
      <DataTable
        columns={columnsFor()}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );
    expect(container.querySelector('.ant-table-filter-trigger.active')).toBeNull();
  });

  it('search header filter commits through onChange and clears when filteredValue resets', async () => {
    const onChange = vi.fn();
    const onSearch = vi.fn();
    const columnsFor = (value?: string) => [
      {
        dataIndex: 'name',
        key: 'name',
        title: 'Name',
        ...searchColumnFilter({ onSearch, value }),
      },
    ];

    const { container, rerender } = render(
      <DataTable
        columns={columnsFor()}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );

    openColumnFilter(container, 'Name');
    const input = await screen.findByTestId('column-search');
    fireEvent.change(input, { target: { value: 'alice' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    expect(onChange.mock.calls.at(-1)![0].filters).toMatchObject({ name: ['alice'] });
    expect(onSearch).toHaveBeenCalledWith('alice');

    rerender(
      <DataTable
        columns={columnsFor('alice')}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );
    expect(container.querySelector('.ant-table-filter-trigger.active')).toBeTruthy();

    rerender(
      <DataTable
        columns={columnsFor()}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );
    expect(container.querySelector('.ant-table-filter-trigger.active')).toBeNull();
  });

  it('date-range header filter commits through onChange and clears when filteredValue resets', async () => {
    const onChange = vi.fn();
    const onRangeChange = vi.fn();
    const columnsFor = (value?: [Date | null, Date | null] | null) => [
      {
        dataIndex: 'created',
        key: 'created',
        title: 'Created',
        ...dateRangeColumnFilter({ onChange: onRangeChange, value }),
      },
    ];

    const { container, rerender } = render(
      <DataTable
        columns={columnsFor()}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );

    openColumnFilter(container, 'Created');
    fireEvent.click(await screen.findByRole('button', { name: 'pick-range' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
    expect(onChange.mock.calls.at(-1)![0].filters).toMatchObject({
      created: ['2026-01-01', '2026-01-31'],
    });
    expect(onRangeChange).toHaveBeenCalledTimes(1);

    const applied = [new Date(2026, 0, 1), new Date(2026, 0, 31)] as [Date, Date];
    rerender(
      <DataTable
        columns={columnsFor(applied)}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );
    expect(container.querySelector('.ant-table-filter-trigger.active')).toBeTruthy();

    rerender(
      <DataTable
        columns={columnsFor(null)}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        onChange={onChange}
      />,
    );
    expect(container.querySelector('.ant-table-filter-trigger.active')).toBeNull();
  });

  it('a controlled page can reset every header filter from DataTable.onChange', async () => {
    const seen = vi.fn();

    const Harness = () => {
      const [status, setStatus] = useState<string | undefined>('active');
      const [query, setQuery] = useState('alice');

      return (
        <>
          <button
            type="button"
            onClick={() => {
              setStatus(undefined);
              setQuery('');
            }}
          >
            clear-headers
          </button>
          <DataTable
            dataSource={rows}
            pagination={false}
            rowKey="id"
            columns={[
              {
                dataIndex: 'status',
                key: 'status',
                title: 'Status',
                ...enumColumnFilter({
                  options: [{ label: 'Active', value: 'active' }],
                  value: status,
                }),
              },
              {
                dataIndex: 'name',
                key: 'name',
                title: 'Name',
                ...searchColumnFilter({ onSearch: setQuery, value: query }),
              },
            ]}
            onChange={(meta) => {
              seen(meta.filters);
            }}
          />
        </>
      );
    };

    const { container } = render(<Harness />);
    expect(container.querySelectorAll('.ant-table-filter-trigger.active')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'clear-headers' }));
    await waitFor(() => {
      expect(container.querySelector('.ant-table-filter-trigger.active')).toBeNull();
    });
  });
});
