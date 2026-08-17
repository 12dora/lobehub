'use client';

import { memo, type ReactNode } from 'react';

import { OverviewLoadErrorAlert, OverviewRefreshWarningAlert } from './OverviewAlerts';
import OverviewCardState from './OverviewCardState';
import { overviewStyles as styles } from './styles';
import type { OverviewCardStateResult } from './useOverviewCardState';

interface OverviewRankSectionProps {
  children: ReactNode;
  empty: {
    desc: string;
    title: string;
  };
  headerExtra?: ReactNode;
  onRetry: () => void;
  state: OverviewCardStateResult;
  title: ReactNode;
}

const OverviewRankSection = memo<OverviewRankSectionProps>(
  ({ children, empty, headerExtra, onRetry, state, title }) => {
    const heading = <h2 className={styles.sectionTitle}>{title}</h2>;

    return (
      <section className={styles.card}>
        {headerExtra ? (
          <div className={styles.cardHead}>
            {heading}
            {headerExtra}
          </div>
        ) : (
          heading
        )}
        {state.staleError ? <OverviewRefreshWarningAlert onRetry={onRetry} /> : null}
        <OverviewCardState stateKey={state.stateKey}>
          {state.firstError ? (
            <OverviewLoadErrorAlert onRetry={onRetry} />
          ) : state.empty ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>{empty.title}</p>
              <p className={styles.emptyDesc}>{empty.desc}</p>
            </div>
          ) : (
            children
          )}
        </OverviewCardState>
      </section>
    );
  },
);

OverviewRankSection.displayName = 'AdminOverviewRankSection';

export default OverviewRankSection;
