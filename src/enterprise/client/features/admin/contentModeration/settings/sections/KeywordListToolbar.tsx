'use client';

import { Text } from '@lobehub/ui';
import { Button, Input, Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE_OPTIONS } from '../../../primitives/dataTableChange';
import { moderationStyles as styles } from '../../styles';

/** Shared admin page-size ladder, numeric for the local slice math. */
const PAGE_SIZE_OPTIONS = DEFAULT_PAGE_SIZE_OPTIONS.map(Number);

export interface KeywordListToolbarProps {
  currentPage: number;
  matched: number;
  onPageChange: (next: (value: number) => number) => void;
  onPageSizeChange: (size: number) => void;
  onSearchChange: (value: string) => void;
  pageCount: number;
  pageSize: number;
  search: string;
}

/** Filter and paging for the rule list — only one page of rows is ever mounted. */
const KeywordListToolbar = memo<KeywordListToolbarProps>(
  ({
    currentPage,
    matched,
    onPageChange,
    onPageSizeChange,
    onSearchChange,
    pageCount,
    pageSize,
    search,
  }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.toolbarRow}>
        <Input
          aria-label={t('contentModeration.settings.keywords.search')}
          placeholder={t('contentModeration.settings.keywords.searchPlaceholder')}
          style={{ width: 260 }}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <Text className={styles.hintText} data-testid="keyword-page-info">
          {t('contentModeration.settings.keywords.pageInfo', {
            matched,
            page: currentPage,
            pages: pageCount,
          })}
        </Text>
        <Select
          aria-label={t('contentModeration.settings.keywords.pageSize')}
          style={{ width: 120 }}
          value={String(pageSize)}
          options={PAGE_SIZE_OPTIONS.map((size) => ({
            label: t('contentModeration.settings.keywords.pageSizeOption', { size }),
            value: String(size),
          }))}
          onChange={(next) => onPageSizeChange(Number(next ?? DEFAULT_PAGE_SIZE))}
        />
        <Button
          disabled={currentPage <= 1}
          size="small"
          onClick={() => onPageChange((value) => Math.max(1, value - 1))}
        >
          {t('contentModeration.settings.keywords.prevPage')}
        </Button>
        <Button
          disabled={currentPage >= pageCount}
          size="small"
          onClick={() => onPageChange((value) => Math.min(pageCount, value + 1))}
        >
          {t('contentModeration.settings.keywords.nextPage')}
        </Button>
      </div>
    );
  },
);
KeywordListToolbar.displayName = 'ModerationKeywordListToolbar';

export default KeywordListToolbar;
