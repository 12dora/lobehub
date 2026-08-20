/**
 * Stable selectors / copy anchors for Admin E2E.
 * Prefer roles + i18n source English strings over CSS/DOM structure.
 */
export const ADMIN_COPY = {
  accessDeniedTitle: 'Admin access denied',
  backHome: 'Back to home',
  featureOffTitle: 'Admin console unavailable',
  managedResourcesTitle: 'Hosting policy',
  mobileUnsupportedTitle: 'Desktop required',
  systemJobsReadOnly: 'You can inspect jobs, but only system operators can retry or cancel.',
  // 「系统」is the nav group header; the status page is its own child entry.
  systemNav: 'Status monitoring',
  systemTitle: 'Status monitoring',
} as const;

export const VIEWPORTS = {
  desktop: { height: 900, width: 1440 },
  mobile: { height: 844, width: 390 },
} as const;
