import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@/const/platform/permissions';

import {
  getPlatformPermissionMetadata,
  type PlatformPermissionMetadata,
} from '../../guards/platformPermission';

export type AdminProcedureKind = 'mutation' | 'query';

export interface AdminProcedurePermissionAuthorization {
  kind: AdminProcedureKind;
  path: `admin.${string}`;
  permission: PlatformPermissionMetadata;
  selfAccess?: never;
}

export interface AdminProcedureSelfAuthorization {
  kind: 'query';
  path: 'admin.auth.getMyAccess';
  permission?: never;
  selfAccess: true;
}

export type AdminProcedureAuthorization =
  AdminProcedurePermissionAuthorization | AdminProcedureSelfAuthorization;

/**
 * Current authorization facts for every procedure exported by adminRouter.
 *
 * OIDC restart procedures retain their dedicated OIDC_PUBLISH gate. Platform diagnostics and
 * generic job controls use the narrower SYSTEM_READ / SYSTEM_OPERATE split.
 */
export const ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY = [
  {
    kind: 'mutation',
    path: 'admin.agents.appendVersion',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.archive',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_DELETE] },
  },
  {
    kind: 'query',
    path: 'admin.agents.assignments.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.agents.assignments.preview',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_ASSIGN] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.assignments.remove',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_ASSIGN] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.assignments.upsert',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_ASSIGN] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.create',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_CREATE] },
  },
  {
    kind: 'query',
    path: 'admin.agents.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.agents.getDependents',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.agents.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.agents.listVersions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.rollouts.cancel',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_ASSIGN] },
  },
  {
    kind: 'query',
    path: 'admin.agents.rollouts.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.agents.rollouts.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.rollouts.retry',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_ASSIGN] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.rollouts.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.rollouts.start',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_ASSIGN] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.setDefaultInbox',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.updateDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.agents.validateDependencies',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiModels.applyImmediate',
    // PUBLISH via middleware; CREATE/UPDATE re-checked inside the procedure (W10-P).
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiModels.create',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiModels.deleteFromDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_DELETE] },
  },
  {
    kind: 'query',
    path: 'admin.aiModels.dependents',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_READ] },
  },
  {
    kind: 'query',
    path: 'admin.aiModels.getCreateDraftContext',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_CREATE] },
  },
  {
    kind: 'query',
    path: 'admin.aiModels.getDeleteDraftContext',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_DELETE] },
  },
  {
    kind: 'query',
    path: 'admin.aiModels.getUpdateDraftContext',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_UPDATE] },
  },
  {
    kind: 'query',
    path: 'admin.aiModels.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_READ] },
  },
  {
    kind: 'query',
    path: 'admin.aiModels.listCreateTargets',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiModels.reorder',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiModels.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_MODEL_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiProviders.applyImmediate',
    // PUBLISH via middleware; CREATE/UPDATE re-checked inside the procedure (W10-P).
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiProviders.archive',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiProviders.createDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE] },
  },
  {
    kind: 'query',
    path: 'admin.aiProviders.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ] },
  },
  {
    kind: 'query',
    path: 'admin.aiProviders.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ] },
  },
  {
    kind: 'query',
    path: 'admin.aiProviders.listRevisions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiProviders.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiProviders.publishNow',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiProviders.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiProviders.test',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_TEST] },
  },
  {
    kind: 'mutation',
    path: 'admin.aiProviders.updateDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE] },
  },
  {
    kind: 'query',
    path: 'admin.audit.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  { kind: 'query', path: 'admin.auth.getMyAccess', selfAccess: true },
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
    kind: 'mutation',
    path: 'admin.connectors.archive',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.createDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.deleteDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.discover',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_TEST] },
  },
  {
    kind: 'query',
    path: 'admin.connectors.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ] },
  },
  {
    kind: 'query',
    path: 'admin.connectors.getPublishedBatch',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ] },
  },
  {
    kind: 'query',
    path: 'admin.connectors.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.revokeAllBindings',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.test',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_TEST] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.updateDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.createFile',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.createKV',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.createOAuth',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.delete',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.deleteByKey',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_DELETE] },
  },
  {
    kind: 'query',
    path: 'admin.creds.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'query',
    path: 'admin.creds.getByKey',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'query',
    path: 'admin.creds.getSkillCredStatus',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'query',
    path: 'admin.creds.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'query',
    path: 'admin.creds.listOAuthConnections',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.creds.uploadFile',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CRED_CREATE] },
  },
  {
    kind: 'query',
    path: 'admin.easyauth.getSyncStatus',
    permission: {
      mode: 'any',
      permissions: [PLATFORM_PERMISSIONS.ROLE_READ, PLATFORM_PERMISSIONS.SYSTEM_READ],
    },
  },
  {
    kind: 'mutation',
    path: 'admin.easyauth.triggerSync',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.ROLE_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.create',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.delete',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.discover',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_TEST] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.getCallbackUrls',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.listPublishedRevisions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_PUBLISH] },
  },
  {
    kind: 'query',
    path: 'admin.identityProviders.testResult',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_TEST] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.testStart',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_TEST] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.identityProviders.validateNetwork',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.IDENTITY_TEST] },
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
    kind: 'query',
    path: 'admin.roles.listSystemRoles',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.ROLE_READ] },
  },
  {
    kind: 'query',
    path: 'admin.roles.listUserAssignments',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.ROLE_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.roles.replaceUserGlobalRoles',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.ROLE_UPDATE] },
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
    kind: 'mutation',
    path: 'admin.skills.archive',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_DELETE] },
  },
  {
    kind: 'mutation',
    path: 'admin.skills.create',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.skills.createVersion',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_UPDATE] },
  },
  {
    kind: 'query',
    path: 'admin.skills.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_READ] },
  },
  {
    kind: 'query',
    path: 'admin.skills.getDependents',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_READ] },
  },
  {
    kind: 'query',
    path: 'admin.skills.getVersion',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_READ] },
  },
  {
    kind: 'query',
    path: 'admin.skills.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_READ] },
  },
  {
    kind: 'query',
    path: 'admin.skills.listVersions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.skills.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.skills.rollback',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.skills.updateDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.skills.validate',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_UPDATE] },
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
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.STATS_READ] },
  },
  {
    kind: 'query',
    path: 'admin.stats.totals',
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
  {
    kind: 'mutation',
    path: 'admin.users.ban',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_BAN] },
  },
  {
    kind: 'query',
    path: 'admin.users.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_READ] },
  },
  {
    kind: 'query',
    path: 'admin.users.getAuditTrail',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.users.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.replaceGlobalRoles',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_ROLE_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.revokeSessions',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_SESSION_REVOKE] },
  },
  {
    kind: 'mutation',
    path: 'admin.users.unban',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.USER_BAN] },
  },
] as const satisfies readonly AdminProcedureAuthorization[];

export interface TrpcProcedureDefinition {
  _def?: {
    type?: unknown;
  };
}

export interface AdminAuthorizationReconciliationInput {
  adminProcedures: Readonly<Record<string, TrpcProcedureDefinition>>;
  lambdaProcedures: Readonly<Record<string, TrpcProcedureDefinition>>;
  mutationPaths: readonly `admin.${string}`[];
  registry?: readonly AdminProcedureAuthorization[];
}

const samePermissions = (
  actual: readonly PlatformPermission[],
  expected: readonly PlatformPermission[],
): boolean =>
  actual.length === expected.length &&
  actual.every((permission, index) => permission === expected[index]);

/**
 * Reconcile static declarations with live tRPC objects. This never invokes a resolver.
 */
export const reconcileAdminProcedureAuthorization = ({
  adminProcedures,
  lambdaProcedures,
  mutationPaths,
  registry = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY,
}: AdminAuthorizationReconciliationInput): void => {
  const failures: string[] = [];
  const declarations = new Map<string, AdminProcedureAuthorization>();

  for (const declaration of registry) {
    if (declarations.has(declaration.path))
      failures.push(`duplicate registry path: ${declaration.path}`);
    declarations.set(declaration.path, declaration);
  }

  const actualPaths = new Set(Object.keys(adminProcedures).map((path) => `admin.${path}`));
  for (const path of actualPaths) {
    if (!declarations.has(path)) failures.push(`missing registry path: ${path}`);
  }
  for (const path of declarations.keys()) {
    if (!actualPaths.has(path)) failures.push(`stale registry path: ${path}`);
  }

  const mountedAdminEntries = Object.entries(lambdaProcedures).filter(([path]) =>
    path.startsWith('admin.'),
  );
  for (const [relativePath, procedure] of Object.entries(adminProcedures)) {
    const expectedPath = `admin.${relativePath}`;
    const identityMounts = mountedAdminEntries.filter(([, mounted]) => mounted === procedure);
    if (identityMounts.length !== 1 || identityMounts[0]?.[0] !== expectedPath) {
      failures.push(`invalid lambda mount: ${expectedPath}`);
    }

    const declaration = declarations.get(expectedPath);
    if (!declaration) continue;

    if (procedure._def?.type !== declaration.kind) {
      failures.push(`kind mismatch: ${expectedPath}`);
    }

    const permissionMetadata = getPlatformPermissionMetadata(procedure);
    if ('selfAccess' in declaration) {
      if (permissionMetadata.length !== 0)
        failures.push(`self-access has permission gate: ${expectedPath}`);
      continue;
    }

    if (permissionMetadata.length !== 1) {
      failures.push(`expected exactly one permission gate: ${expectedPath}`);
      continue;
    }
    const [actual] = permissionMetadata;
    if (
      actual.mode !== declaration.permission.mode ||
      !samePermissions(actual.permissions, declaration.permission.permissions)
    ) {
      failures.push(`permission mismatch: ${expectedPath}`);
    }
  }

  for (const [mountedPath] of mountedAdminEntries) {
    if (!actualPaths.has(mountedPath))
      failures.push(`unexpected lambda admin mount: ${mountedPath}`);
  }

  const actualMutations = new Set<`admin.${string}`>(
    Object.entries(adminProcedures)
      .filter(([, procedure]) => procedure._def?.type === 'mutation')
      .map(([path]) => `admin.${path}` as const),
  );
  const registeredMutations = new Set(mutationPaths);
  for (const path of actualMutations) {
    if (!registeredMutations.has(path)) failures.push(`missing mutation risk entry: ${path}`);
  }
  for (const path of registeredMutations) {
    if (!actualMutations.has(path)) failures.push(`stale mutation risk entry: ${path}`);
  }

  if (failures.length > 0) throw new Error(failures.join('\n'));
};

export const isAuthorizedByPlatformPermissions = (
  authorization: AdminProcedureAuthorization,
  permissions: ReadonlySet<PlatformPermission>,
): boolean => {
  if ('selfAccess' in authorization) return true;
  return authorization.permission.mode === 'all'
    ? authorization.permission.permissions.every((permission) => permissions.has(permission))
    : authorization.permission.permissions.some((permission) => permissions.has(permission));
};
