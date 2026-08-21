import { Flexbox, Icon, SearchBar, Select } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { ArrowDownNarrowWide, Loader2Icon, Search } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface SortOption {
  label: string;
  value: string;
}

interface FilterBarProps {
  /**
   * A refetch for a changed filter is in flight while rows are still on
   * screen. Renders a spinner next to the search box instead of collapsing the
   * list into a skeleton — the results the user is looking at stay readable.
   */
  loading?: boolean;
  onSearch: (value: string) => void;
  onSortChange?: (sort: string) => void;
  searchValue: string;
  sortOptions?: SortOption[];
  sortValue?: string;
}

const FilterBar = memo<FilterBarProps>(
  ({ searchValue, onSearch, sortValue, onSortChange, sortOptions, loading }) => {
    const { t } = useTranslation('memory');

    return (
      <Flexbox horizontal align={'center'} gap={12}>
        <SearchBar
          allowClear
          defaultValue={searchValue}
          placeholder={t('filter.search')}
          prefix={<Search size={16} />}
          style={{ flex: 1 }}
          onSearch={(v) => onSearch(v)}
          onInputChange={(v) => {
            if (!v) {
              onSearch(v);
            }
          }}
        />
        {loading && <Icon spin color={cssVar.colorTextQuaternary} icon={Loader2Icon} size={16} />}
        {sortOptions && sortOptions.length > 0 && onSortChange && (
          <Select
            options={sortOptions}
            prefix={<Icon icon={ArrowDownNarrowWide} style={{ marginRight: 4 }} />}
            style={{ minWidth: 150 }}
            value={sortValue}
            onChange={(value) => onSortChange(value as string)}
          />
        )}
      </Flexbox>
    );
  },
);

export default FilterBar;
