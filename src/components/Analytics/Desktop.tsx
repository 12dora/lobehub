'use client';

import { memo } from 'react';

const DesktopAnalytics = memo(() => {
  // AIHub: built-in telemetry removed. Desktop Umami tracking is disabled unconditionally,
  // regardless of NEXT_PUBLIC_DESKTOP_PROJECT_ID / NEXT_PUBLIC_DESKTOP_UMAMI_BASE_URL.
  return null;
});

export default DesktopAnalytics;
