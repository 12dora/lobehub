'use client';

import type { ReactNode } from 'react';
import { memo } from 'react';

import { ManagedResourceBoundary } from '@/features/ManagedResources';

interface ManagedConnectorSettingsProps {
  fallback: ReactNode;
}

/**
 * Guard for user/workspace connector settings routes.
 * When connectors are platform-managed, blocks the ordinary settings surface
 * (ManagedResourceNotice). Per-user OAuth must not stay on this entry path —
 * ship a dedicated surface later if needed.
 */
const ManagedConnectorSettings = memo<ManagedConnectorSettingsProps>(({ fallback }) => {
  return <ManagedResourceBoundary resource="connectors">{fallback}</ManagedResourceBoundary>;
});

ManagedConnectorSettings.displayName = 'ManagedConnectorSettings';

export default ManagedConnectorSettings;
