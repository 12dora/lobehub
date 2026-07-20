/**
 * Stable selectors / copy anchors for Admin E2E.
 * Prefer roles + i18n source English strings over CSS/DOM structure.
 */
export const ADMIN_COPY = {
  accessDeniedTitle: 'Admin access denied',
  backHome: 'Back to home',
  featureOffTitle: 'Admin console unavailable',
  managedResourcesTitle: 'Managed resources',
  mobileUnsupportedTitle: 'Desktop required',
  systemJobsReadOnly: 'You can inspect jobs, but only system operators can retry or cancel.',
  systemNav: 'System',
  systemTitle: 'System',
} as const;

export const VIEWPORTS = {
  desktop: { height: 900, width: 1440 },
  mobile: { height: 844, width: 390 },
} as const;
