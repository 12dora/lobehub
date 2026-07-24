import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type { AdminProcedureAuthorization } from './types';

/** Authorization declarations for admin.branding/managedResources/security/settings/sidebarLayout/stats/system procedures. */
export const ADMIN_PROCEDURE_AUTHORIZATION_PLATFORM = [
  {
    kind: 'query',
    path: 'admin.branding.getDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.BRANDING_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.branding.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.BRANDING_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.branding.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.BRANDING_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.branding.saveDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.BRANDING_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.branding.uploadAsset',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.BRANDING_UPDATE] },
  },
  {
    kind: 'query',
    path: 'admin.managedResources.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.POLICY_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.managedResources.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.POLICY_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.managedResources.saveDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.POLICY_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.security.secretRotation.cancel',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'query',
    path: 'admin.security.secretRotation.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
  },
  {
    kind: 'query',
    path: 'admin.security.secretRotation.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.security.secretRotation.restart',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.security.secretRotation.retry',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.security.secretRotation.start',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.settings.applyImmediate',
    // UPDATE via middleware; PUBLISH re-checked inside the procedure (W10-C).
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SETTINGS_UPDATE] },
  },
  {
    kind: 'query',
    path: 'admin.settings.getDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SETTINGS_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.settings.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SETTINGS_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.settings.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SETTINGS_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.settings.saveDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SETTINGS_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.settings.validateDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SETTINGS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.sidebarLayout.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.POLICY_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.sidebarLayout.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.POLICY_UPDATE] },
  },
  {
    kind: 'query',
    path: 'admin.stats.countAgents',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.countMessages',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.countTopics',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.getHeatmaps',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.getMaxTaskDuration',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.getTokenHeatmaps',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.rankAgents',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.rankModels',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.rankTopics',
    // Topic titles/ids are conversation evidence — both STATS_READ + AUDIT_CONVERSATION_READ (F4).
    permission: {
      mode: 'all',
      permissions: [PLATFORM_PERMISSIONS.STATS_READ, PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ],
    },
  },
  {
    kind: 'query',
    path: 'admin.stats.totals',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.userTotals',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.usageDailyTokenTotals',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.usageFindAndGroupByDay',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.usageFindByMonth',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.system.cancelJob',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'query',
    path: 'admin.system.getAuthSnapshotStatus',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.OIDC_PUBLISH] },
  },
  {
    kind: 'query',
    path: 'admin.system.getInstanceRevisions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
  },
  {
    kind: 'query',
    path: 'admin.system.getJobs',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
  },
  {
    kind: 'query',
    path: 'admin.system.getStatus',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.system.prepareRestart',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.OIDC_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.system.requestRestart',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.OIDC_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.system.retryJob',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
] as const satisfies readonly AdminProcedureAuthorization[];
