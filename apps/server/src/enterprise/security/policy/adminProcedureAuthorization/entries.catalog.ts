import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import type { AdminProcedureAuthorization } from './types';

/** Authorization declarations for admin.agents/aiModels/aiProviders/skills procedures. */
export const ADMIN_PROCEDURE_AUTHORIZATION_CATALOG = [
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
    kind: 'mutation',
    path: 'admin.agents.delete',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AGENT_DELETE] },
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
    kind: 'mutation',
    path: 'admin.aiProviders.delete',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_DELETE] },
  },
  {
    kind: 'query',
    path: 'admin.aiProviders.get',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AI_PROVIDER_READ] },
  },
  {
    kind: 'query',
    path: 'admin.aiProviders.getBatch',
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
    kind: 'mutation',
    path: 'admin.skills.applyImmediate',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_PUBLISH] },
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
    path: 'admin.skills.parseImportSource',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_CREATE] },
  },
  {
    kind: 'mutation',
    path: 'admin.skills.publish',
    permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.SKILL_PUBLISH] },
  },
  {
    kind: 'mutation',
    path: 'admin.skills.publishNow',
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
] as const satisfies readonly AdminProcedureAuthorization[];
