'use client';

import { Flexbox } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { Fragment, type ReactNode } from 'react';

const styles = createStaticStyles(({ css }) => ({
  state: css`
    animation: managed-resource-enter ${cssVar.motionDurationMid} ${cssVar.motionEaseInOut};

    @keyframes managed-resource-enter {
      from {
        transform: translateY(4px);
        opacity: 0;
      }

      to {
        transform: translateY(0);
        opacity: 1;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      animation: none;
    }
  `,
}));

interface ManagedResourceTransitionProps {
  children: ReactNode;
  state: 'content' | 'error' | 'loading' | 'managed';
}

/**
 * Layout-transparent in the `content` state: it renders the page exactly where
 * upstream renders it, with no DOM box in between. Upstream has no wrapper here,
 * and full-bleed catalog pages (provider / skill / connector) depend on that:
 * their inner `height: 100%` + `overflow: auto` panes only become scrollports
 * when the height chain from the settings pane down is unbroken, so an extra
 * `flex: 1` box with an auto height silently kills their scrolling.
 *
 * The animated box is kept only for the notice states (loading / error /
 * managed), which render their own centred content and need a bounded box —
 * hence `height: 100%` + `min-height: 0`.
 */
export const ManagedResourceTransition = ({ children, state }: ManagedResourceTransitionProps) =>
  state === 'content' ? (
    <Fragment key={state}>{children}</Fragment>
  ) : (
    <Flexbox
      className={styles.state}
      data-managed-resource-state={state}
      flex={1}
      height={'100%'}
      key={state}
      style={{ minHeight: 0 }}
    >
      {children}
    </Flexbox>
  );
