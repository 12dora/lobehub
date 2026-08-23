'use client';

import { Button } from '@lobehub/ui/base-ui';
import { DatePicker } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { styles } from './operationLogsStyles';

export interface LogsTableToolbarProps {
  from: Date;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  onRangeChange: (from: Date, to: Date) => void;
  to: Date;
}

/** Evidence window picker for the log table, with an escape hatch out of every active filter. */
const LogsTableToolbar = memo<LogsTableToolbarProps>(
  ({ from, hasActiveFilters, onClearFilters, onRangeChange, to }) => {
    const { t } = useTranslation('admin');

    const rangeValue: [Dayjs, Dayjs] = useMemo(() => [dayjs(from), dayjs(to)], [from, to]);

    return (
      <div className={styles.tableToolbar}>
        <DatePicker.RangePicker
          showTime
          allowClear={false}
          className={styles.timeRange}
          value={rangeValue}
          onChange={(vals) => {
            if (!vals?.[0] || !vals[1]) return;
            onRangeChange(vals[0].toDate(), vals[1].toDate());
          }}
        />
        {hasActiveFilters ? (
          <Button size="small" type="text" onClick={onClearFilters}>
            {t('audit.shared.clearFilters')}
          </Button>
        ) : null}
      </div>
    );
  },
);

LogsTableToolbar.displayName = 'AuditLogsTableToolbar';

export default LogsTableToolbar;
