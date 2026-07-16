/**
 * @vitest-environment happy-dom
 */
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

vi.mock('@/components/NeuralNetworkLoading', () => ({ default: () => null }));

type Row = { id: string; name: string };

describe('DataTable cursor pagination', () => {
  it('renders previous/next without a fabricated total', () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const onRowActivate = vi.fn();

    render(
      <DataTable<Row>
        columns={[{ dataIndex: 'name', key: 'name', title: 'Name' }]}
        dataSource={[{ id: '1', name: 'A' }]}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: true,
          hasPrevious: false,
          onNext,
          onPrevious,
        }}
        onRowActivate={onRowActivate}
      />,
    );

    expect(screen.queryByText(/total/i)).toBeNull();
    fireEvent.click(screen.getByText('primitives.dataTable.next'));
    expect(onNext).toHaveBeenCalledTimes(1);

    const row = screen.getByRole('link');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onRowActivate).toHaveBeenCalledWith({ id: '1', name: 'A' });
  });
});
