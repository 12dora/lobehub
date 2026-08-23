/**
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DataTable from './DataTable';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const catalog: Record<string, string> = {
        'primitives.dataTable.itemsPerPage': '/ page',
        'primitives.dataTable.nextPage': 'Next page',
        'primitives.dataTable.prevPage': 'Previous page',
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
    Select: ({ value, onChange, options, 'aria-label': aria }: any) =>
      React.createElement(
        'select',
        {
          'aria-label': aria,
          value,
          'onChange': (e: any) => onChange?.(e.target.value),
        },
        (options ?? []).map((o: any) =>
          React.createElement('option', { key: o.value, value: o.value }, o.label),
        ),
      ),
  };
});

vi.mock('@/components/NeuralNetworkLoading', () => ({ default: () => null }));

type Row = { id: string; name: string };

/** The cursor paginator is antd's `Pagination`; page buttons are `li.ant-pagination-item-N`. */
const cursorNav = () => screen.getByLabelText('primitives.dataTable.cursorNav');
const pageButton = (page: number) =>
  cursorNav().querySelector(`.ant-pagination-item-${page}`) as HTMLElement;
const nextArrow = () => cursorNav().querySelector('.ant-pagination-next') as HTMLElement;
const prevArrow = () => cursorNav().querySelector('.ant-pagination-prev') as HTMLElement;

describe('DataTable cursor pagination', () => {
  it('renders numeric page buttons without a fabricated total', () => {
    const onNext = vi.fn();
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
          onPrevious: vi.fn(),
          page: 1,
          pageSize: 20,
        }}
        onRowActivate={onRowActivate}
      />,
    );

    // No total line and no quick jumper — a keyset list does not know its size.
    expect(cursorNav().querySelector('.ant-pagination-total-text')).toBeNull();
    expect(cursorNav().querySelector('.ant-pagination-options-quick-jumper')).toBeNull();

    // The reachable pages stop exactly one past the current one.
    expect(pageButton(1)).toBeTruthy();
    expect(pageButton(2)).toBeTruthy();
    expect(pageButton(3)).toBeNull();
    expect(within(pageButton(1)).getByText('1')).toBeTruthy();

    fireEvent.click(within(pageButton(2)).getByText('2'));
    expect(onNext).toHaveBeenCalledTimes(1);

    const row = screen.getByRole('link');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onRowActivate).toHaveBeenCalledWith({ id: '1', name: 'A' });
  });

  it('disables the next arrow at the end of the list and enables previous', () => {
    const onNext = vi.fn();

    render(
      <DataTable<Row>
        columns={[{ dataIndex: 'name', key: 'name', title: 'Name' }]}
        dataSource={[{ id: '1', name: 'A' }]}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: false,
          hasPrevious: true,
          onNext,
          onPrevious: vi.fn(),
          page: 3,
          pageSize: 20,
        }}
      />,
    );

    expect(pageButton(3)?.className).toContain('ant-pagination-item-active');
    expect(pageButton(4)).toBeNull();
    expect(nextArrow().className).toContain('ant-pagination-disabled');
    expect(prevArrow().className).not.toContain('ant-pagination-disabled');

    fireEvent.click(nextArrow());
    expect(onNext).not.toHaveBeenCalled();
  });

  it('jumps backwards to the exact page when the owner tracks its cursor stack', () => {
    const onJumpTo = vi.fn();
    const onPrevious = vi.fn();

    render(
      <DataTable<Row>
        columns={[{ dataIndex: 'name', key: 'name', title: 'Name' }]}
        dataSource={[{ id: '1', name: 'A' }]}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: true,
          hasPrevious: true,
          onJumpTo,
          onNext: vi.fn(),
          onPrevious,
          page: 3,
          pageSize: 20,
        }}
      />,
    );

    fireEvent.click(within(pageButton(1)).getByText('1'));
    expect(onJumpTo).toHaveBeenCalledWith(1);
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it('clamps a backward page click to a single step when no onJumpTo is provided', () => {
    const onPrevious = vi.fn();

    render(
      <DataTable<Row>
        columns={[{ dataIndex: 'name', key: 'name', title: 'Name' }]}
        dataSource={[{ id: '1', name: 'A' }]}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: false,
          hasPrevious: true,
          onNext: vi.fn(),
          onPrevious,
          page: 4,
          pageSize: 20,
        }}
      />,
    );

    fireEvent.click(within(pageButton(1)).getByText('1'));
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('empty cursor page retains the paginator so the user is not trapped', () => {
    const onPrevious = vi.fn();

    render(
      <DataTable<Row>
        columns={[{ dataIndex: 'name', key: 'name', title: 'Name' }]}
        dataSource={[]}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: false,
          hasPrevious: true,
          onNext: vi.fn(),
          onPrevious,
          page: 2,
          pageSize: 20,
        }}
      />,
    );

    expect(screen.getByText('primitives.dataTable.empty')).toBeTruthy();
    fireEvent.click(prevArrow());
    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('shares the numeric paginator page-size changer, resetting to page 1', () => {
    const onPageSizeChange = vi.fn();
    const onJumpTo = vi.fn();

    render(
      <DataTable<Row>
        columns={[{ dataIndex: 'name', key: 'name', title: 'Name' }]}
        dataSource={[{ id: '1', name: 'A' }]}
        pagination={false}
        rowKey="id"
        cursorPagination={{
          hasNext: true,
          hasPrevious: true,
          onJumpTo,
          onNext: vi.fn(),
          onPageSizeChange,
          onPrevious: vi.fn(),
          page: 2,
          pageSize: 20,
        }}
      />,
    );

    const sizeChanger = cursorNav().querySelector('.ant-pagination-options') as HTMLElement;
    expect(sizeChanger).toBeTruthy();
    expect(within(sizeChanger).getByText('20 / page')).toBeTruthy();

    fireEvent.mouseDown(sizeChanger.querySelector('.ant-select-content') as HTMLElement);
    fireEvent.click(screen.getByTitle('50 / page'));

    expect(onPageSizeChange).toHaveBeenCalledWith(50);
    // A size change must not be mistaken for a page jump.
    expect(onJumpTo).not.toHaveBeenCalled();
  });

  it('does not activate the row when a nested button is clicked or keyboard-activated', () => {
    const onRowActivate = vi.fn();
    const onNested = vi.fn();

    render(
      <DataTable<Row>
        dataSource={[{ id: '1', name: 'A' }]}
        pagination={false}
        rowKey="id"
        columns={[
          {
            dataIndex: 'name',
            key: 'name',
            title: 'Name',
            render: () => (
              <button type="button" onClick={onNested}>
                nested-action
              </button>
            ),
          },
        ]}
        onRowActivate={onRowActivate}
      />,
    );

    const nested = screen.getByRole('button', { name: 'nested-action' });
    fireEvent.click(nested);
    expect(onNested).toHaveBeenCalledTimes(1);
    expect(onRowActivate).not.toHaveBeenCalled();

    fireEvent.keyDown(nested, { key: 'Enter' });
    expect(onRowActivate).not.toHaveBeenCalled();
  });
});
