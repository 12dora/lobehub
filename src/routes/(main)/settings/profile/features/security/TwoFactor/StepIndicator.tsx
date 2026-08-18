'use client';

import { Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';

const styles = createStaticStyles(({ css }) => ({
  bar: css`
    flex: 1;

    height: 3px;
    border-radius: 2px;

    background: ${cssVar.colorFillSecondary};

    transition: background 0.2s ease;
  `,
  barDone: css`
    background: ${cssVar.colorPrimary};
  `,
  label: css`
    font-size: ${cssVar.fontSizeSM};
    font-weight: 500;
  `,
  root: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  track: css`
    display: flex;
    gap: 4px;
  `,
}));

interface StepIndicatorProps {
  /** 0-based index of the step the user is on. */
  current: number;
  /** Ordered step labels; length is the total. */
  steps: string[];
}

/**
 * Position + total for the enrolment flow (ux Grow: any flow over two steps says where the
 * user is). Kept to filled segments plus the current label so it stays legible at the
 * modal's width without truncating four sentence-length step names.
 */
const StepIndicator = memo<StepIndicatorProps>(({ current, steps }) => (
  <div className={styles.root}>
    <div
      aria-label={steps[current]}
      aria-valuemax={steps.length}
      aria-valuemin={1}
      aria-valuenow={current + 1}
      className={styles.track}
      role="progressbar"
    >
      {steps.map((step, index) => (
        <span className={`${styles.bar} ${index <= current ? styles.barDone : ''}`} key={step} />
      ))}
    </div>
    <Text as="span" className={styles.label}>
      {`${current + 1}/${steps.length} · ${steps[current]}`}
    </Text>
  </div>
));

StepIndicator.displayName = 'TwoFactorStepIndicator';

export default StepIndicator;
