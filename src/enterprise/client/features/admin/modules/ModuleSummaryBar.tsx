'use client';

import { Text, Tooltip } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PlatformModuleStateMap } from '@/const/platform/modules';

import { comparePresets, summarizeModules } from './moduleDraft';

const styles = createStaticStyles(({ css }) => ({
  compare: css`
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;

    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  item: css`
    display: flex;
    flex: 1 1 140px;
    flex-direction: column;
    gap: 2px;
  `,
  root: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
  `,
  value: css`
    font-size: 18px;
    font-weight: 600;
  `,
}));

export interface ModuleSummaryBarProps {
  /** The local draft — the numbers must move as the operator flips switches, not after saving. */
  draft: PlatformModuleStateMap;
  /** Modules whose change only frees resources after a process restart. */
  restartRequiredCount: number;
}

/**
 * What this selection costs, live. The point of the page is a resource decision, so the
 * consequences have to be visible while choosing — not discovered on the next deploy.
 *
 * Memory is reported as "at least N MB" whenever some enabled module has no measurement yet;
 * claiming a precise total we do not have would be worse than admitting the gap.
 */
const ModuleSummaryBar = memo<ModuleSummaryBarProps>(({ draft, restartRequiredCount }) => {
  const { t } = useTranslation('admin');
  const summary = useMemo(() => summarizeModules(draft), [draft]);
  const comparisons = useMemo(() => comparePresets(draft), [draft]);

  const standard = comparisons.find((entry) => entry.preset === 'standard');

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <div className={styles.item}>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('modules.summary.idleRss')}
          </Text>
          <Tooltip title={summary.unmeasured > 0 ? t('modules.summary.unmeasuredHint') : undefined}>
            <span className={styles.value} style={summary.measured === 0 ? { fontSize: 14 } : undefined}>
              {/* No measurement at all ⇒ say so. "≥ 0 MB" would read as a real, tiny number. */}
              {summary.measured === 0
                ? t('modules.summary.unmeasured')
                : summary.unmeasured > 0
                  ? t('modules.summary.idleRssAtLeast', { mb: summary.idleRssMb })
                  : t('modules.summary.idleRssValue', { mb: summary.idleRssMb })}
            </span>
          </Tooltip>
        </div>
        <div className={styles.item}>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('modules.summary.backgroundJobs')}
          </Text>
          <span className={styles.value}>{summary.backgroundJobs}</span>
        </div>
        <div className={styles.item}>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('modules.summary.perMessage')}
          </Text>
          <span className={styles.value}>{summary.workPerRequest}</span>
        </div>
        <div className={styles.item}>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('modules.summary.externalDeps')}
          </Text>
          <span className={styles.value} style={{ fontSize: 14 }}>
            {summary.externalDeps.length === 0
              ? t('modules.summary.noExternalDeps')
              : summary.externalDeps.map((dep) => t(`modules.deps.${dep}` as never)).join(' · ')}
          </span>
        </div>
        <div className={styles.item}>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('modules.summary.restartPending')}
          </Text>
          <span className={styles.value}>{restartRequiredCount}</span>
        </div>
      </div>
      {standard ? (
        <div className={styles.compare}>
          <span>
            {/* Comparing two partial memory sums would invent precision, so drop that half
                until the constant table is fully measured. */}
            {standard.idleRssComparable
              ? t('modules.summary.compareStandard', {
                  jobs: Math.abs(standard.backgroundJobsDelta),
                  jobsDirection: t(
                    standard.backgroundJobsDelta <= 0
                      ? 'modules.summary.fewer'
                      : 'modules.summary.more',
                  ),
                  mb: Math.abs(standard.idleRssMbDelta),
                  mbDirection: t(
                    standard.idleRssMbDelta <= 0 ? 'modules.summary.less' : 'modules.summary.more',
                  ),
                })
              : t('modules.summary.compareStandardJobs', {
                  jobs: Math.abs(standard.backgroundJobsDelta),
                  jobsDirection: t(
                    standard.backgroundJobsDelta <= 0
                      ? 'modules.summary.fewer'
                      : 'modules.summary.more',
                  ),
                })}
          </span>
        </div>
      ) : null}
    </div>
  );
});

ModuleSummaryBar.displayName = 'AdminModuleSummaryBar';

export default ModuleSummaryBar;
