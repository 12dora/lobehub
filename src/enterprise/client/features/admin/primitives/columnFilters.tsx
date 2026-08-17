'use client';

import { Button, Input } from '@lobehub/ui/base-ui';
import type { TableColumnType } from 'antd';
import { DatePicker } from 'antd';
import type { FilterDropdownProps, FilterValue } from 'antd/es/table/interface';
import { createStaticStyles, cssVar } from 'antd-style';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { Calendar, Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

const DAY_FORMAT = 'YYYY-MM-DD';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  `,
  dropdown: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    min-width: 240px;
    padding: 8px;
  `,
  icon: css`
    display: inline-flex;
    color: ${cssVar.colorTextTertiary};
  `,
  iconActive: css`
    display: inline-flex;
    color: ${cssVar.colorPrimary};
  `,
}));

/**
 * First non-empty value from an antd column-filter payload (`FilterValue` or a scalar).
 * `undefined` / `[]` / `['']` / `null` collapse to `undefined`.
 */
export const firstColumnFilterValue = (
  value: FilterValue | null | undefined,
): string | undefined => {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null || first === '') return undefined;
  return String(first);
};

const toFilteredValue = (value?: string | string[] | null): FilterValue | null => {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    const next = value.filter((item) => item !== '');
    return next.length > 0 ? next : null;
  }
  return [value];
};

const serializeDateRange = (value?: [Date | null, Date | null] | null): string[] | null => {
  if (!value) return null;
  const [from, to] = value;
  if (!from && !to) return null;
  return [from ? dayjs(from).format(DAY_FORMAT) : '', to ? dayjs(to).format(DAY_FORMAT) : ''];
};

const toDayjsRange = (value?: [Date | null, Date | null] | null): [Dayjs | null, Dayjs | null] => {
  if (!value) return [null, null];
  return [value[0] ? dayjs(value[0]) : null, value[1] ? dayjs(value[1]) : null];
};

const FilterGlyph = ({ active, icon: Glyph }: { active: boolean; icon: typeof Search }) => (
  <span className={active ? styles.iconActive : styles.icon}>
    <Glyph size={14} />
  </span>
);

export interface EnumColumnFilterOption {
  label: ReactNode;
  value: string;
}

export interface EnumColumnFilterOptions {
  /** When true, more than one option can stay selected. Defaults to false. */
  multiple?: boolean;
  options: EnumColumnFilterOption[];
  /** Controlled selection. Pass `undefined` / `[]` to clear the header state. */
  value?: string | string[];
}

/**
 * Ant Design column-header enum filter (`filters` + controlled `filteredValue`).
 * Filter changes flow through `DataTable.onChange({ filters })`.
 */
export const enumColumnFilter = ({
  multiple = false,
  options,
  value,
}: EnumColumnFilterOptions): Pick<
  TableColumnType,
  'filterMultiple' | 'filteredValue' | 'filters'
> => ({
  filterMultiple: multiple,
  filteredValue: toFilteredValue(value),
  filters: options.map((option) => ({ text: option.label, value: option.value })),
});

export interface SearchColumnFilterOptions {
  onSearch: (value: string) => void;
  placeholder?: string;
  /** Controlled search text. Pass `undefined` / `''` to clear the header state. */
  value?: string;
}

const SearchFilterDropdown = ({
  clearFilters,
  confirm,
  onSearch,
  placeholder,
  selectedKeys,
  setSelectedKeys,
}: FilterDropdownProps & Pick<SearchColumnFilterOptions, 'onSearch' | 'placeholder'>) => {
  const { t } = useTranslation('admin');
  const draft = String(selectedKeys[0] ?? '');

  const apply = () => {
    const next = draft.trim();
    setSelectedKeys(next ? [next] : []);
    confirm({ closeDropdown: true });
    onSearch(next);
  };

  const reset = () => {
    setSelectedKeys([]);
    clearFilters?.();
    confirm({ closeDropdown: true });
    onSearch('');
  };

  return (
    <div className={styles.dropdown}>
      <Input
        placeholder={placeholder ?? t('primitives.columnFilter.placeholder')}
        size="small"
        value={draft}
        onChange={(event) => {
          setSelectedKeys(event.target.value ? [event.target.value] : []);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          event.stopPropagation();
          apply();
        }}
      />
      <div className={styles.actions}>
        <Button size="small" type="default" onClick={reset}>
          {t('primitives.columnFilter.reset')}
        </Button>
        <Button size="small" type="primary" onClick={apply}>
          {t('primitives.columnFilter.search')}
        </Button>
      </div>
    </div>
  );
};

/**
 * Column-header search filter. Enter or Search applies; Reset clears.
 * `filteredValue` stays controlled so server-driven pages can reset the header.
 */
export const searchColumnFilter = ({
  onSearch,
  placeholder,
  value,
}: SearchColumnFilterOptions): Pick<
  TableColumnType,
  'filterDropdown' | 'filterIcon' | 'filterOnClose' | 'filteredValue'
> => ({
  filterDropdown: (dropdownProps) => (
    <SearchFilterDropdown {...dropdownProps} placeholder={placeholder} onSearch={onSearch} />
  ),
  filterIcon: (filtered) => (
    <FilterGlyph active={filtered || Boolean(value?.trim())} icon={Search} />
  ),
  filterOnClose: false,
  filteredValue: toFilteredValue(value),
});

export interface DateRangeColumnFilterOptions {
  onChange: (value: [Date | null, Date | null] | null) => void;
  /** Controlled range. Pass `undefined` / `[null, null]` to clear the header state. */
  value?: [Date | null, Date | null] | null;
}

const DateRangeFilterDropdown = ({
  clearFilters,
  confirm,
  onChange,
  selectedKeys,
  setSelectedKeys,
  value,
}: FilterDropdownProps & DateRangeColumnFilterOptions) => {
  const { t } = useTranslation('admin');
  const [draft, setDraft] = useState<[Dayjs | null, Dayjs | null]>(() => {
    if (value) return toDayjsRange(value);
    const from = selectedKeys[0] ? dayjs(String(selectedKeys[0])) : null;
    const to = selectedKeys[1] ? dayjs(String(selectedKeys[1])) : null;
    return [from?.isValid() ? from : null, to?.isValid() ? to : null];
  });

  const apply = () => {
    const next: [Date | null, Date | null] = [
      draft[0]?.toDate() ?? null,
      draft[1]?.toDate() ?? null,
    ];
    const keys = serializeDateRange(next);
    setSelectedKeys(keys ?? []);
    confirm({ closeDropdown: true });
    onChange(keys ? next : null);
  };

  const reset = () => {
    setDraft([null, null]);
    setSelectedKeys([]);
    clearFilters?.();
    confirm({ closeDropdown: true });
    onChange(null);
  };

  return (
    <div className={styles.dropdown}>
      <DatePicker.RangePicker
        allowClear
        getPopupContainer={(trigger) => trigger.parentElement ?? document.body}
        placeholder={[t('timeRange.from'), t('timeRange.to')]}
        size="small"
        style={{ width: '100%' }}
        value={draft}
        onChange={(next) => {
          setDraft([next?.[0] ?? null, next?.[1] ?? null]);
        }}
      />
      <div className={styles.actions}>
        <Button size="small" type="default" onClick={reset}>
          {t('primitives.columnFilter.reset')}
        </Button>
        <Button size="small" type="primary" onClick={apply}>
          {t('primitives.columnFilter.apply')}
        </Button>
      </div>
    </div>
  );
};

/**
 * Column-header date-range filter (compact antd `RangePicker`).
 * Apply commits; Reset clears. `filteredValue` stays controlled.
 */
export const dateRangeColumnFilter = ({
  onChange,
  value,
}: DateRangeColumnFilterOptions): Pick<
  TableColumnType,
  'filterDropdown' | 'filterIcon' | 'filterOnClose' | 'filteredValue'
> => ({
  filterDropdown: (dropdownProps) => (
    <DateRangeFilterDropdown {...dropdownProps} value={value} onChange={onChange} />
  ),
  filterIcon: (filtered) => (
    <FilterGlyph active={filtered || Boolean(serializeDateRange(value))} icon={Calendar} />
  ),
  filterOnClose: false,
  filteredValue: serializeDateRange(value),
});
