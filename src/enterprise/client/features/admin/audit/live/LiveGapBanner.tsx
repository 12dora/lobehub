'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { ReactNode } from 'react';
import { memo } from 'react';

import { styles } from './liveStyles';

export interface LiveGapBannerProps {
  actionLabel: ReactNode;
  message: ReactNode;
  onAction: () => void;
  /** `alert` for failures the auditor must notice, `status` for recoverable feed gaps. */
  role: 'alert' | 'status';
}

/** Inline warning strip with a single recovery action, shared by every live-feed interruption. */
const LiveGapBanner = memo<LiveGapBannerProps>(({ actionLabel, message, onAction, role }) => (
  <div className={styles.gapBanner} role={role}>
    <Text>{message}</Text>
    <Button size="small" type="primary" onClick={onAction}>
      {actionLabel}
    </Button>
  </div>
));

LiveGapBanner.displayName = 'AuditLiveGapBanner';

export default LiveGapBanner;
