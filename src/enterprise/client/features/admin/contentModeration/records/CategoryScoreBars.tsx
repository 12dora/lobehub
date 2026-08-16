'use client';

import { Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ModerationCategory,
  ModerationCategoryAction,
} from '@/const/platform/contentModeration';
import { MODERATION_CATEGORIES } from '@/const/platform/contentModeration';

import {
  buildCategoryRows,
  categoryLabel,
  formatScore,
  policyActionLabel,
  sortCategoriesByScore,
} from '../format';
import { moderationStyles as styles } from '../styles';

export interface CategoryScoreBarsProps {
  scores: Partial<Record<string, number>> | null | undefined;
  /** Thresholds as they were AT DECISION TIME — never the current settings. */
  thresholds:
    | Partial<Record<string, { action: ModerationCategoryAction; threshold: number }>>
    | null
    | undefined;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Score-vs-threshold bars for all ten categories. The threshold is drawn as a tick on the
 * bar so a decision can be re-read months later, even after the policy changed — which is
 * exactly why the record stores a threshold snapshot (design §4.2 / §6.2).
 */
const CategoryScoreBars = memo<CategoryScoreBarsProps>(({ scores, thresholds }) => {
  const { t } = useTranslation('admin');
  const rows = sortCategoriesByScore(
    buildCategoryRows(MODERATION_CATEGORIES as readonly ModerationCategory[], scores, thresholds),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {rows.map((row) => (
        <div
          className={styles.barRow}
          data-testid={`category-bar-${row.category}`}
          key={row.category}
        >
          <Text ellipsis style={{ fontSize: 12, margin: 0 }}>
            {categoryLabel(t, row.category)}
          </Text>
          <div className={styles.bar}>
            <div
              className={row.hit ? styles.barFillHit : styles.barFill}
              style={{ width: `${clamp01(row.score) * 100}%` }}
            />
            {typeof row.threshold === 'number' ? (
              <span
                className={styles.barThreshold}
                data-testid={`category-threshold-${row.category}`}
                style={{ insetInlineStart: `${clamp01(row.threshold) * 100}%` }}
                title={t('contentModeration.records.thresholdTitle', {
                  action: policyActionLabel(t, row.action ?? 'ignore'),
                  threshold: formatScore(row.threshold),
                })}
              />
            ) : null}
          </div>
          <span className={styles.barValue}>
            {formatScore(row.score)} / {formatScore(row.threshold)}
          </span>
        </div>
      ))}
    </div>
  );
});

CategoryScoreBars.displayName = 'ModerationCategoryScoreBars';

export default CategoryScoreBars;
