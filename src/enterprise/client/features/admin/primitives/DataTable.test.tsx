import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DataTable from './DataTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const catalog: Record<string, string> = {
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
  };
});

vi.mock('@/components/NeuralNetworkLoading', () => ({
  default: () => null,
}));

type Row = { id: string; name: string };

const columns = [{ dataIndex: 'name', key: 'name', sorter: true, title: 'Name' }];

const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({
  id: String(i + 1),
  name: `User ${i + 1}`,
}));

describe('DataTable server-driven list', () => {
  it('shows loading and never empty while loading', () => {
    render(
      <DataTable
        loading
        columns={columns}
        dataSource={[]}
        pagination={{ current: 1, pageSize: 20, total: 10_000 }}
        rowKey="id"
      />,
    );
    expect(screen.getByText('primitives.dataTable.loading')).toBeTruthy();
    expect(screen.queryByText('primitives.dataTable.empty')).toBeNull();
  });

  it('shows error before empty', () => {
    render(<DataTable error columns={columns} dataSource={[]} rowKey="id" onRetry={() => {}} />);
    expect(screen.getByText('primitives.dataTable.error')).toBeTruthy();
    expect(screen.queryByText('primitives.dataTable.empty')).toBeNull();
  });

  it('page change calls onPaginationChange exactly once with correct values', () => {
    const onPaginationChange = vi.fn();
    const onChange = vi.fn();

    render(
      <DataTable
        virtual
        columns={columns}
        dataSource={rows}
        pagination={{ current: 1, pageSize: 20, total: 10_000 }}
        rowKey="id"
        scroll={{ y: 480 }}
        onChange={onChange}
        onPaginationChange={onPaginationChange}
      />,
    );

    fireEvent.click(screen.getByTitle('2'));

    expect(onPaginationChange).toHaveBeenCalledTimes(1);
    expect(onPaginationChange).toHaveBeenCalledWith(2, 20);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('page-size change calls onPaginationChange exactly once (resets to page 1)', () => {
    const onPaginationChange = vi.fn();
    const onChange = vi.fn();

    const { container } = render(
      <DataTable
        columns={columns}
        dataSource={rows}
        rowKey="id"
        pagination={{
          current: 3,
          pageSize: 25,
          pageSizeOptions: ['25', '50', '100'],
          showSizeChanger: true,
          total: 10_000,
        }}
        onChange={onChange}
        onPaginationChange={onPaginationChange}
      />,
    );

    // Ant Design 5 size changer (portal options after open)
    const sizeChanger =
      container.querySelector('.ant-pagination-options-size-changer .ant-select-content') ||
      container.querySelector('.ant-pagination-options-size-changer');
    expect(sizeChanger).toBeTruthy();
    fireEvent.mouseDown(sizeChanger!);

    const option50 = [...document.querySelectorAll('.ant-select-item')].find((el) =>
      el.textContent?.includes('50'),
    );
    expect(option50).toBeTruthy();
    fireEvent.click(option50!);

    // Single callback path — not double-fired via pagination.onChange + table.onChange
    expect(onPaginationChange).toHaveBeenCalledTimes(1);
    // Ant Design resets to page 1 when pageSize changes
    expect(onPaginationChange).toHaveBeenCalledWith(1, 50);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].pagination).toMatchObject({
      current: 1,
      pageSize: 50,
    });
  });

  it('supports row selection config without crashing', () => {
    const onChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        rowSelection={{
          onChange: (keys) => onChange(keys),
          selectedRowKeys: [],
        }}
      />,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[1]!);
    expect(onChange).toHaveBeenCalled();
  });

  it('selects a row without also activating it', () => {
    const onSelectionChange = vi.fn();
    const onRowActivate = vi.fn();
    render(
      <DataTable
        columns={columns}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        rowSelection={{
          onChange: (keys) => onSelectionChange(keys),
          selectedRowKeys: [],
        }}
        onRowActivate={onRowActivate}
      />,
    );

    // The selection checkbox is a nested interactive control: ticking it must not open the row.
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    expect(onSelectionChange).toHaveBeenCalled();
    expect(onRowActivate).not.toHaveBeenCalled();
  });

  it('accepts large-list scroll/virtual props', () => {
    const { container } = render(
      <DataTable
        virtual
        columns={columns}
        dataSource={rows}
        pagination={{ current: 1, pageSize: 100, total: 50_000 }}
        rowKey="id"
        scroll={{ x: 1200, y: 600 }}
      />,
    );
    expect(container.querySelector('.ant-table')).toBeTruthy();
  });

  it('renders a right-aligned toolbar above the table', () => {
    render(
      <DataTable
        columns={columns}
        dataSource={rows}
        pagination={false}
        rowKey="id"
        toolbar={<button type="button">bulk-disable</button>}
      />,
    );

    expect(screen.getByRole('button', { name: 'bulk-disable' })).toBeTruthy();
  });

  it('keeps the toolbar mounted while loading and on error so search does not blink out', () => {
    const { rerender } = render(
      <DataTable
        loading
        columns={columns}
        pagination={false}
        rowKey="id"
        toolbar={<input aria-label="search" />}
      />,
    );
    expect(screen.getByLabelText('search')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();

    rerender(
      <DataTable
        error
        columns={columns}
        pagination={false}
        rowKey="id"
        toolbar={<input aria-label="search" />}
      />,
    );
    expect(screen.getByLabelText('search')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('shows total, jump-to-page, and i18n page-size suffix when total is known', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        dataSource={rows}
        pagination={{ current: 1, pageSize: 25, total: 10_000 }}
        rowKey="id"
      />,
    );

    expect(screen.getByText('10000 items')).toBeTruthy();
    expect(container.querySelector('.ant-pagination-options-quick-jumper')).toBeTruthy();
    expect(container.querySelector('.ant-pagination-end, .ant-table-pagination')).toBeTruthy();

    const sizeChanger =
      container.querySelector('.ant-pagination-options-size-changer .ant-select-content') ||
      container.querySelector('.ant-pagination-options-size-changer');
    expect(sizeChanger).toBeTruthy();
    fireEvent.mouseDown(sizeChanger!);

    const option25 = [...document.querySelectorAll('.ant-select-item')].find((el) =>
      el.textContent?.includes('25 / page'),
    );
    expect(option25).toBeTruthy();
  });

  it('does not show a total line when showTotal is opted out', () => {
    render(
      <DataTable
        columns={columns}
        dataSource={rows}
        pagination={{ current: 1, pageSize: 20, showTotal: false, total: 10_000 }}
        rowKey="id"
      />,
    );

    expect(screen.queryByText('10000 items')).toBeNull();
  });

  it('keeps numeric pagination when the current page is empty but total is nonzero', () => {
    const onPaginationChange = vi.fn();

    render(
      <DataTable
        columns={columns}
        dataSource={[]}
        pagination={{ current: 2, pageSize: 20, total: 40 }}
        rowKey="id"
        onPaginationChange={onPaginationChange}
      />,
    );

    expect(screen.getByText('primitives.dataTable.empty')).toBeTruthy();
    expect(screen.getByText('40 items')).toBeTruthy();
    fireEvent.click(screen.getByTitle('1'));
    expect(onPaginationChange).toHaveBeenCalledWith(1, 20);
  });

  it('merges rowClassName with the row activation class, and works without onRowActivate', () => {
    const rowClassName = (record: Row, index: number) =>
      index === 0 ? `highlight-${record.id}` : undefined;

    const { container, rerender } = render(
      <DataTable<Row>
        columns={columns}
        dataSource={rows}
        pagination={false}
        rowClassName={rowClassName}
        rowKey="id"
        onRowActivate={() => {}}
      />,
    );

    const firstRow = container.querySelector('.ant-table-tbody tr[data-row-key="1"]')!;
    expect(firstRow.classList.contains('admin-table-row-clickable')).toBe(true);
    expect(firstRow.classList.contains('highlight-1')).toBe(true);

    const secondRow = container.querySelector('.ant-table-tbody tr[data-row-key="2"]')!;
    expect(secondRow.classList.contains('admin-table-row-clickable')).toBe(true);
    expect(secondRow.className).not.toContain('highlight-');

    // Without onRowActivate the row stays non-interactive but still gets the extra class.
    rerender(
      <DataTable<Row>
        columns={columns}
        dataSource={rows}
        pagination={false}
        rowClassName={rowClassName}
        rowKey="id"
      />,
    );

    const plainRow = container.querySelector('.ant-table-tbody tr[data-row-key="1"]')!;
    expect(plainRow.classList.contains('highlight-1')).toBe(true);
    expect(plainRow.classList.contains('admin-table-row-clickable')).toBe(false);
    expect(plainRow.getAttribute('role')).toBeNull();
  });

  it('does not keep numeric pagination when the list is truly empty', () => {
    const { container } = render(
      <DataTable
        columns={columns}
        dataSource={[]}
        pagination={{ current: 1, pageSize: 20, total: 0 }}
        rowKey="id"
      />,
    );

    expect(screen.getByText('primitives.dataTable.empty')).toBeTruthy();
    expect(container.querySelector('.ant-pagination')).toBeNull();
  });
});
