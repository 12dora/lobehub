import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DataTable from './DataTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
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

  it('propagates pagination change for server lists', () => {
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

    const page2 = screen.getByTitle('2');
    fireEvent.click(page2);

    expect(onPaginationChange).toHaveBeenCalledWith(2, 20);
    expect(onChange).toHaveBeenCalled();
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
});
