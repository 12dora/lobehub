'use client';

import { Text } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditEventsStats } from '@/enterprise/client/services/adminAudit';

import type { AuditResult } from './listFilters';
import { styles } from './operationLogsStyles';

export interface LogStatCardsProps {
  activeResult: AuditResult | null;
  /** True when no result filter is applied, i.e. the "total" card is the active one. */
  allActive: boolean;
  onToggleResult: (result: AuditResult | null) => void;
  stats: AdminAuditEventsStats | undefined;
}

/** Outcome totals for the current window, doubling as the one-click result filter. */
const LogStatCards = memo<LogStatCardsProps>(
  ({ activeResult, allActive, onToggleResult, stats }) => {
    const { t } = useTranslation('admin');

    const statCards = [
      {
        key: 'total',
        label: t('audit.logs.stats.total'),
        onClick: () => onToggleResult(null),
        value: stats?.total ?? '—',
        active: allActive,
        color: undefined as string | undefined,
      },
      {
        key: 'success',
        label: t('audit.logs.stats.success'),
        onClick: () => onToggleResult('success'),
        value: stats?.success ?? '—',
        active: activeResult === 'success',
        color: cssVar.colorSuccess,
      },
      {
        key: 'failure',
        label: t('audit.logs.stats.failure'),
        onClick: () => onToggleResult('failure'),
        value: stats?.failure ?? '—',
        active: activeResult === 'failure',
        color: cssVar.colorError,
      },
      {
        key: 'denied',
        label: t('audit.logs.stats.denied'),
        onClick: () => onToggleResult('denied'),
        value: stats?.denied ?? '—',
        active: activeResult === 'denied',
        color: cssVar.colorWarning,
      },
    ];

    return (
      <div className={styles.stats}>
        {statCards.map((card) => (
          <button
            className={styles.statCard}
            data-active={card.active}
            data-testid={`stat-${card.key}`}
            key={card.key}
            type="button"
            onClick={card.onClick}
          >
            <Text
              data-testid={`stat-${card.key}-label`}
              style={{ margin: 0, fontWeight: card.active ? 600 : undefined }}
              type={card.active ? undefined : 'secondary'}
            >
              {card.label}
            </Text>
            <p
              className={styles.statValue}
              data-testid={`stat-${card.key}-value`}
              style={card.color ? { color: card.color } : undefined}
            >
              {card.value}
            </p>
          </button>
        ))}
      </div>
    );
  },
);

LogStatCards.displayName = 'AuditLogStatCards';

export default LogStatCards;
