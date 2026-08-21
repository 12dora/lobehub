import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import {
  buildTablePagination,
  DEFAULT_PAGE_SIZE,
  DEFAULT_PAGE_SIZE_OPTIONS,
} from './dataTableChange';

const t = ((key: string, options?: Record<string, unknown>) =>
  options && 'total' in options ? `${key}:${options.total}` : key) as unknown as TFunction<'admin'>;

describe('admin page size defaults', () => {
  it('is the single source of truth for every admin list', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(25);
    expect([...DEFAULT_PAGE_SIZE_OPTIONS]).toEqual(['25', '50', '100']);
    // The default must be selectable in the size changer, otherwise the control shows
    // a value that is absent from its own option list.
    expect([...DEFAULT_PAGE_SIZE_OPTIONS]).toContain(String(DEFAULT_PAGE_SIZE));
  });
});

describe('buildTablePagination', () => {
  it('falls back to the shared page size and options', () => {
    const config = buildTablePagination({
      pagination: { current: 1, pageSize: 0, total: 120 },
      t,
    });

    expect(config).toMatchObject({
      align: 'end',
      current: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      pageSizeOptions: ['25', '50', '100'],
      placement: ['bottomEnd'],
      showQuickJumper: true,
      showSizeChanger: true,
      total: 120,
    });
  });

  it('renders showTotal through the admin locale when the total is known', () => {
    const config = buildTablePagination({
      pagination: { current: 1, pageSize: DEFAULT_PAGE_SIZE, total: 120 },
      t,
    });

    if (config === false) throw new Error('expected a pagination config');
    expect(config.showTotal?.(120, [1, 25])).toBe('primitives.dataTable.showTotal:120');
  });

  it('drops showTotal and the quick jumper when the total is unknown', () => {
    const config = buildTablePagination({
      pagination: { current: 1, pageSize: 25, total: Number.POSITIVE_INFINITY },
      t,
    });

    if (config === false) throw new Error('expected a pagination config');
    expect(config.showTotal).toBeUndefined();
    expect(config.showQuickJumper).toBe(false);
    // Size changer still applies: cursor-free lists keep the shared ladder.
    expect(config.pageSizeOptions).toEqual(['25', '50', '100']);
  });

  it('yields no antd pagination for cursor lists', () => {
    expect(
      buildTablePagination({
        cursorPagination: {
          hasNext: true,
          hasPrevious: false,
          onNext: () => {},
          onPrevious: () => {},
        },
        pagination: { current: 1, pageSize: 25, total: 10 },
        t,
      }),
    ).toBe(false);
  });
});
