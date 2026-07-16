'use client';

import { Flexbox, SearchBar } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  type AdminFilterValues,
  clearAdminFilters,
  hasActiveAdminFilters,
} from './filterBar.utils';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;

    padding-block: 8px;
    padding-inline: 0;
  `,
  search: css`
    flex: 1;
    min-width: 220px;
    max-width: 360px;
  `,
  slot: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
}));

export interface FilterBarProps {
  /** Extra filter controls (Selects, etc.) placed after search. */
  extra?: ReactNode;
  onChange: (next: AdminFilterValues) => void;
  searchPlaceholder?: string;
  values: AdminFilterValues;
}

/**
 * Standard admin list filter row: search + optional filters + clear.
 * Keyboard: SearchBar is focusable; Clear is a real button.
 */
const FilterBar = memo<FilterBarProps>(({ values, onChange, extra, searchPlaceholder }) => {
  const { t } = useTranslation('admin');
  const active = hasActiveAdminFilters(values);

  return (
    <div className={styles.root}>
      <div className={styles.search}>
        <SearchBar
          allowClear
          placeholder={searchPlaceholder ?? t('primitives.filterBar.searchPlaceholder')}
          value={values.query}
          variant="filled"
          onInputChange={(value) => {
            onChange({ ...values, query: value });
          }}
          onSearch={(value) => {
            onChange({ ...values, query: value });
          }}
        />
      </div>
      {extra ? <div className={styles.slot}>{extra}</div> : null}
      {active ? (
        <Button
          size="small"
          type="text"
          onClick={() => {
            onChange(clearAdminFilters(values));
          }}
        >
          {t('primitives.filterBar.clear')}
        </Button>
      ) : null}
      <Flexbox flex={1} style={{ minWidth: 0 }} />
    </div>
  );
});

FilterBar.displayName = 'AdminFilterBar';

export default FilterBar;
