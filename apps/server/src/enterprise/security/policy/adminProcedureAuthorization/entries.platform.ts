import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type { AdminProcedureAuthorization } from './types';

/** Authorization declarations for admin.browserProfile/branding/contentModeration/managedResources/security/settings/sidebarLayout/stats/system procedures. */
export const ADMIN_PROCEDURE_AUTHORIZATION_PLATFORM = [
  {
    kind: 'query',
    path: 'admin.browserProfile.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
  },
  {
    kind: 'query',
    path: 'admin.browserProfile.options',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.browserProfile.regenerate',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.browserProfile.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'query',
    path: 'admin.branding.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.BRANDING_READ] },
  },
  {
    kind: 'mutation',
    // save always publishes — both UPDATE and PUBLISH are required.
    path: 'admin.branding.save',
    permission: {
      mode: 'all',
      permissions: [PLATFORM_PERMISSIONS.BRANDING_UPDATE, PLATFORM_PERMISSIONS.BRANDING_PUBLISH],
    },
  },
  {
    kind: 'mutation',
    path: 'admin.branding.uploadAsset',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.BRANDING_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.contentModeration.clearDecisionCache',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.contentModeration.deleteRecords',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_MANAGE] },
  },
  {
    kind: 'query',
    path: 'admin.contentModeration.getOverview',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_READ] },
  },
  {
    kind: 'query',
    path: 'admin.contentModeration.getRecord',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_READ] },
  },
  {
    kind: 'query',
    path: 'admin.contentModeration.getSettings',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_READ] },
  },
  {
    kind: 'query',
    path: 'admin.contentModeration.getStats',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_READ] },
  },
  {
    kind: 'query',
    path: 'admin.contentModeration.listRecords',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.contentModeration.revealRecordPrompt',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.contentModeration.testClassifier',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.contentModeration.updateSettings',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.MODERATION_MANAGE] },
  },
  {
    kind: 'query',
    path: 'admin.managedResources.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.POLICY_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.managedResources.save',
    // save always publishes — both UPDATE and PUBLISH are required.
    permission: {
      mode: 'all',
      permissions: [PLATFORM_PERMISSIONS.POLICY_UPDATE, PLATFORM_PERMISSIONS.POLICY_PUBLISH],
    },
  },
  {
    kind: 'query',
    path: 'admin.modules.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.modules.requestRestart',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.modules.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.createSubscription',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.deleteSubscription',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'query',
    path: 'admin.networkProxy.getArtifactStatus',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.networkProxy.getEngineLogs',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.networkProxy.getSettings',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.networkProxy.getStatus',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.installArtifact',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.installGeodata',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'query',
    path: 'admin.networkProxy.listNodes',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.networkProxy.listSubscriptions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.refreshSubscription',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.restartEngine',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.selectNode',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.testConnectivity',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.testLatency',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.updateScopes',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.updateSettings',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.networkProxy.updateSubscription',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.NETWORK_PROXY_MANAGE] },
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
    // applyImmediate always publishes — both UPDATE and PUBLISH are required.
    permission: {
      mode: 'all',
      permissions: [PLATFORM_PERMISSIONS.SETTINGS_UPDATE, PLATFORM_PERMISSIONS.SETTINGS_PUBLISH],
    },
  },
  {
    kind: 'query',
    path: 'admin.settings.getDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SETTINGS_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.settings.save',
    // save always publishes — both UPDATE and PUBLISH are required.
    permission: {
      mode: 'all',
      permissions: [PLATFORM_PERMISSIONS.SETTINGS_UPDATE, PLATFORM_PERMISSIONS.SETTINGS_PUBLISH],
    },
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
    path: 'admin.stats.activitySeries',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
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
    path: 'admin.stats.rankUsers',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
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
    path: 'admin.system.getInfraSettings',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_READ] },
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
  {
    kind: 'mutation',
    path: 'admin.system.testDependency',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.system.updateInfraSettings',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SYSTEM_OPERATE] },
  },
] as const satisfies readonly AdminProcedureAuthorization[];
