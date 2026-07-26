'use client';

import { Flexbox } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import type { ReactNode } from 'react';

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

export const ManagedResourceTransition = ({ children, state }: ManagedResourceTransitionProps) => (
  <Flexbox className={styles.state} data-managed-resource-state={state} flex={1} key={state}>
    {children}
  </Flexbox>
);
