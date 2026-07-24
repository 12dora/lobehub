import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type { AdminProcedureAuthorization } from './types';

/** Authorization declarations for admin.audit/connectors procedures. */
export const ADMIN_PROCEDURE_AUTHORIZATION_AUDIT_CONNECTORS = [
  {
    kind: 'query',
    path: 'admin.audit.conversations.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.conversations.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.conversations.messages',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.events.facets',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.events.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.events.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.events.stats',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.exports.cancel',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.exports.create',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.exports.download',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT] },
  },
  {
    kind: 'query',
    path: 'admin.audit.exports.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT] },
  },
  {
    kind: 'query',
    path: 'admin.audit.exports.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT] },
  },
  {
    kind: 'query',
    path: 'admin.audit.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.legalHolds.create',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE] },
  },
  {
    kind: 'query',
    path: 'admin.audit.legalHolds.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE] },
  },
  {
    kind: 'query',
    path: 'admin.audit.legalHolds.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.legalHolds.release',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_LEGAL_HOLD_MANAGE] },
  },
  {
    kind: 'query',
    path: 'admin.audit.list',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.policy.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.policy.update',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_POLICY_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.retention.cancel',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.retention.dryRun',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE] },
  },
  {
    kind: 'query',
    path: 'admin.audit.retention.getRun',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE] },
  },
  {
    kind: 'query',
    path: 'admin.audit.retention.listRuns',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.audit.retention.run',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE] },
  },
  {
    kind: 'query',
    path: 'admin.audit.retention.status',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE] },
  },
  {
    kind: 'query',
    path: 'admin.audit.users.search',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.users.summary',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
  },
  {
    kind: 'query',
    path: 'admin.audit.users.timeline',
    // Conversation evidence — same gate as admin.audit.conversations.* (F2).
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_CONVERSATION_READ] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.applyImmediate',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_PUBLISH] },
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
    path: 'admin.connectors.getBatch',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_READ] },
  },
  {
    kind: 'query',
    path: 'admin.connectors.getGovernance',
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
    path: 'admin.connectors.publishNow',
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
    path: 'admin.connectors.setSharedAuthorization',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.test',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_TEST] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.updateBuiltinToolPolicy',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_UPDATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.connectors.updateDraft',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.CONNECTOR_UPDATE] },
  },
] as const satisfies readonly AdminProcedureAuthorization[];
