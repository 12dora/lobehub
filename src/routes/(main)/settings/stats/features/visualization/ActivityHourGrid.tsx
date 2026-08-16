import { Flexbox } from '@lobehub/ui';
import { Tooltip, TooltipGroup } from '@lobehub/ui/base-ui';
import { createStaticStyles, keyframes, useTheme, useThemeMode } from 'antd-style';
import { type CSSProperties, memo, type ReactNode, useMemo } from 'react';

import type { StatsActivityBucket } from '@/features/SettingsStats';

import { type ActivityHourCell, HOURS_PER_DAY, toActivityHourRows } from './activity.utils';

/** Matches the calendar heatmap, so both windows share one colour scale. */
const MAX_LEVEL = 4;

/** Hours that get a label under the strip: 00 / 06 / 12 / 18. */
const AXIS_STEP = 6;

const HOUR_SLOTS = Array.from({ length: HOURS_PER_DAY }, (_, hour) => hour);

/** Block metrics, mirroring the shortest calendar window on each form factor. */
const BLOCK = {
  desktop: { gap: 6, radius: 5, size: 28 },
  mobile: { gap: 3, radius: 2, size: 10 },
};

const pulse = keyframes`
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.45;
  }
`;

const styles = createStaticStyles(({ css, cssVar }) => ({
  axis: css`
    display: flex;
    gap: var(--activity-hour-gap);
    align-items: center;

    font-size: 12px;
    line-height: 1;
    color: ${cssVar.colorTextDescription};
  `,
  block: css`
    width: var(--activity-hour-size);
    height: var(--activity-hour-size);
    border-radius: var(--activity-hour-radius);
    box-shadow: inset 0 0 0 1px ${cssVar.colorFillTertiary};
  `,
  blockEmpty: css`
    width: var(--activity-hour-size);
    height: var(--activity-hour-size);
  `,
  blockLoading: css`
    animation: ${pulse} 1.75s ease-in-out infinite;

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
  container: css`
    align-self: center;
    max-width: 100%;
  `,
  dayLabel: css`
    flex: none;

    min-width: 2.6em;
    padding-inline-end: 4px;

    font-size: 12px;
    line-height: 1;
    color: ${cssVar.colorTextDescription};
    text-align: end;
  `,
  legend: css`
    display: flex;
    gap: 4px;
    align-items: center;

    margin-inline-start: auto;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  row: css`
    display: flex;
    gap: var(--activity-hour-gap);
    align-items: center;
  `,
  rows: css`
    display: flex;
    flex-direction: column;
    gap: var(--activity-hour-gap);
    width: max-content;
  `,
  scrollContainer: css`
    overflow: auto hidden;
    max-width: 100%;
    padding-block: 2px;
  `,
  slot: css`
    display: flex;
    flex: none;
    justify-content: center;

    width: var(--activity-hour-size);

    white-space: nowrap;
  `,
}));

interface ActivityHourGridProps {
  /** Same tooltip copy the calendar uses, so both windows read alike. */
  customTooltip: (cell: ActivityHourCell) => ReactNode;
  data?: StatsActivityBucket[];
  labels: { less: string; more: string };
  loading?: boolean;
  mobile?: boolean;
}

/**
 * A sub-48h window drawn with the calendar heatmap's own squares: one 24-block row per
 * day, an hour axis beneath it, the same level colours and the same legend.
 *
 * The calendar chart itself cannot draw this — its grid is a week per column, so an
 * hourly window would collapse into a block or two — but everything visible here comes
 * from it, so changing the range never changes what kind of chart the card shows.
 */
const ActivityHourGrid = memo<ActivityHourGridProps>(
  ({ customTooltip, data, labels, loading, mobile }) => {
    const theme = useTheme();
    const { isDarkMode } = useThemeMode();

    // The chart's own scale: level 0 plus one step per level, so a block of a given
    // shade means the same thing whichever window the reader picked.
    const levelColors = useMemo(
      () => [
        theme.colorFillSecondary,
        isDarkMode ? theme.lime2 : theme.green2,
        isDarkMode ? theme.lime4 : theme.green4,
        isDarkMode ? theme.lime6 : theme.green6,
        isDarkMode ? theme.lime8 : theme.green8,
      ],
      [isDarkMode, theme],
    );

    const rows = useMemo(() => (loading ? [] : toActivityHourRows(data)), [data, loading]);
    const showDayLabels = rows.some((row) => row.dayLabel);
    const block = mobile ? BLOCK.mobile : BLOCK.desktop;

    const cssVars = {
      '--activity-hour-gap': `${block.gap}px`,
      '--activity-hour-radius': `${block.radius}px`,
      '--activity-hour-size': `${block.size}px`,
    } as CSSProperties;

    // Nothing settled yet — keep the empty strip rather than collapsing the card, so
    // the layout does not jump once the series lands.
    const placeholder = rows.length === 0;

    const renderBlock = (cell: ActivityHourCell | undefined, hour: number) => {
      if (!cell)
        return (
          <div className={styles.slot} key={hour}>
            <div className={styles.blockEmpty} />
          </div>
        );

      return (
        <Tooltip key={hour} title={customTooltip(cell)}>
          <div className={styles.slot}>
            <div
              className={styles.block}
              data-level={cell.level}
              style={{ background: levelColors[Math.min(cell.level, MAX_LEVEL)] }}
            />
          </div>
        </Tooltip>
      );
    };

    return (
      <TooltipGroup>
        <Flexbox className={styles.container} gap={8} style={cssVars}>
          <div className={styles.scrollContainer}>
            <div className={styles.rows}>
              {placeholder ? (
                <div className={styles.row}>
                  {HOUR_SLOTS.map((hour) => (
                    <div className={styles.slot} key={hour}>
                      <div
                        style={{ background: levelColors[0] }}
                        className={
                          loading ? `${styles.block} ${styles.blockLoading}` : styles.block
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : (
                rows.map((row) => (
                  <div className={styles.row} key={row.day}>
                    {showDayLabels && <span className={styles.dayLabel}>{row.dayLabel}</span>}
                    {HOUR_SLOTS.map((hour) => renderBlock(row.hours[hour], hour))}
                  </div>
                ))
              )}
              <div className={styles.axis}>
                {showDayLabels && <span className={styles.dayLabel} />}
                {HOUR_SLOTS.map((hour) => (
                  <span className={styles.slot} key={hour}>
                    {hour % AXIS_STEP === 0 ? String(hour).padStart(2, '0') : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {!loading && (
            <div className={styles.legend}>
              <span>{labels.less}</span>
              {levelColors.map((color, level) => (
                <span className={styles.block} key={level} style={{ background: color }} />
              ))}
              <span>{labels.more}</span>
            </div>
          )}
        </Flexbox>
      </TooltipGroup>
    );
  },
);

ActivityHourGrid.displayName = 'ActivityHourGrid';

export default ActivityHourGrid;
