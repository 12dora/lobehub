import { createStaticStyles } from 'antd-style';
import { memo } from 'react';

const styles = createStaticStyles(({ css, cssVar }) => ({
  block: css`
    flex: none;
    box-shadow: inset 0 0 0 1px ${cssVar.colorFillTertiary};
  `,
  legend: css`
    display: flex;
    gap: 4px;
    align-items: center;
    justify-content: flex-end;

    width: 100%;
    margin-block-start: 8px;

    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
}));

interface ActivityLegendProps {
  blockRadius: number;
  blockSize: number;
  /** Level 0 first, darkest last — the calendar's own scale. */
  colors: string[];
  labels: { less: string; more: string };
}

/**
 * The calendar chart's 较少 → 较多 legend, drawn by hand for the ranged card: its
 * built-in one would list the dimmed out-of-range half of the palette too.
 */
const ActivityLegend = memo<ActivityLegendProps>(({ blockRadius, blockSize, colors, labels }) => (
  <div className={styles.legend}>
    <span>{labels.less}</span>
    {colors.map((color, level) => (
      <span
        className={styles.block}
        key={level}
        style={{
          background: color,
          borderRadius: blockRadius,
          height: blockSize,
          width: blockSize,
        }}
      />
    ))}
    <span>{labels.more}</span>
  </div>
));

ActivityLegend.displayName = 'ActivityLegend';

export default ActivityLegend;
