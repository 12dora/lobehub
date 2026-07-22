import type {
  PlatformAgentConnectorDependencyRef,
  PlatformAgentModelDependencyRef,
  PlatformAgentSkillDependencyRef,
  PlatformAgentVersionConfig,
} from '@lobechat/types';

import type {
  AdminPlatformAgentAppendVersionInput,
  AdminPlatformAgentAppendVersionOutput,
  AdminPlatformAgentArchiveInput,
  AdminPlatformAgentArchiveOutput,
  AdminPlatformAgentAssignmentListInput,
  AdminPlatformAgentAssignmentListOutput,
  AdminPlatformAgentAssignmentPreviewInput,
  AdminPlatformAgentAssignmentPreviewOutput,
  AdminPlatformAgentAssignmentRemoveInput,
  AdminPlatformAgentAssignmentRemoveOutput,
  AdminPlatformAgentAssignmentUpsertInput,
  AdminPlatformAgentAssignmentUpsertOutput,
  AdminPlatformAgentCreateInput,
  AdminPlatformAgentCreateOutput,
  AdminPlatformAgentDeleteInput,
  AdminPlatformAgentDeleteOutput,
  AdminPlatformAgentDependentsInput,
  AdminPlatformAgentDependentsOutput,
  AdminPlatformAgentGetInput,
  AdminPlatformAgentGetOutput,
  AdminPlatformAgentListInput,
  AdminPlatformAgentListOutput,
  AdminPlatformAgentPublishInput,
  AdminPlatformAgentPublishOutput,
  AdminPlatformAgentRollbackInput,
  AdminPlatformAgentRollbackOutput,
  AdminPlatformAgentRolloutCancelInput,
  AdminPlatformAgentRolloutCancelOutput,
  AdminPlatformAgentRolloutGetInput,
  AdminPlatformAgentRolloutGetOutput,
  AdminPlatformAgentRolloutListInput,
  AdminPlatformAgentRolloutListOutput,
  AdminPlatformAgentRolloutRetryInput,
  AdminPlatformAgentRolloutRetryOutput,
  AdminPlatformAgentRolloutRollbackInput,
  AdminPlatformAgentRolloutRollbackOutput,
  AdminPlatformAgentRolloutStartInput,
  AdminPlatformAgentRolloutStartOutput,
  AdminPlatformAgentSetDefaultInboxInput,
  AdminPlatformAgentSetDefaultInboxOutput,
  AdminPlatformAgentUpdateDraftInput,
  AdminPlatformAgentUpdateDraftOutput,
  AdminPlatformAgentValidateDependenciesInput,
  AdminPlatformAgentValidateDependenciesOutput,
  AdminPlatformAgentVersionsListInput,
  AdminPlatformAgentVersionsListOutput,
} from '@/server/enterprise/contracts/platformAgents';

export type {
  AdminPlatformAgentAppendVersionInput,
  AdminPlatformAgentAppendVersionOutput,
  AdminPlatformAgentArchiveInput,
  AdminPlatformAgentArchiveOutput,
  AdminPlatformAgentAssignmentListInput,
  AdminPlatformAgentAssignmentListOutput,
  AdminPlatformAgentAssignmentPreviewInput,
  AdminPlatformAgentAssignmentPreviewOutput,
  AdminPlatformAgentAssignmentRemoveInput,
  AdminPlatformAgentAssignmentRemoveOutput,
  AdminPlatformAgentAssignmentUpsertInput,
  AdminPlatformAgentAssignmentUpsertOutput,
  AdminPlatformAgentCreateInput,
  AdminPlatformAgentCreateOutput,
  AdminPlatformAgentDeleteInput,
  AdminPlatformAgentDeleteOutput,
  AdminPlatformAgentDependentsInput,
  AdminPlatformAgentDependentsOutput,
  AdminPlatformAgentGetInput,
  AdminPlatformAgentGetOutput,
  AdminPlatformAgentListInput,
  AdminPlatformAgentListOutput,
  AdminPlatformAgentPublishInput,
  AdminPlatformAgentPublishOutput,
  AdminPlatformAgentRollbackInput,
  AdminPlatformAgentRollbackOutput,
  AdminPlatformAgentRolloutCancelInput,
  AdminPlatformAgentRolloutCancelOutput,
  AdminPlatformAgentRolloutGetInput,
  AdminPlatformAgentRolloutGetOutput,
  AdminPlatformAgentRolloutListInput,
  AdminPlatformAgentRolloutListOutput,
  AdminPlatformAgentRolloutRetryInput,
  AdminPlatformAgentRolloutRetryOutput,
  AdminPlatformAgentRolloutRollbackInput,
  AdminPlatformAgentRolloutRollbackOutput,
  AdminPlatformAgentRolloutStartInput,
  AdminPlatformAgentRolloutStartOutput,
  AdminPlatformAgentSetDefaultInboxInput,
  AdminPlatformAgentSetDefaultInboxOutput,
  AdminPlatformAgentUpdateDraftInput,
  AdminPlatformAgentUpdateDraftOutput,
  AdminPlatformAgentValidateDependenciesInput,
  AdminPlatformAgentValidateDependenciesOutput,
  AdminPlatformAgentVersionsListInput,
  AdminPlatformAgentVersionsListOutput,
};

export type AdminAgentListInput = AdminPlatformAgentListInput;
export type AdminAgentListItem = AdminPlatformAgentListOutput['items'][number];
export type AdminAgentListOutput = AdminPlatformAgentListOutput;
export type AdminAgentAssignmentPreviewOutput = AdminPlatformAgentAssignmentPreviewOutput;

/** Client-only aggregate assembled from the independently paged endpoint outputs. */
export interface AdminAgentDetailOutput extends AdminPlatformAgentGetOutput {
  assignments: AdminPlatformAgentAssignmentListOutput['items'];
  rollouts: AdminPlatformAgentRolloutListOutput['items'];
  versions: AdminPlatformAgentVersionsListOutput['items'];
}

export type AdminAgentModelDependency = PlatformAgentModelDependencyRef;
export type AdminAgentSkillDependency = PlatformAgentSkillDependencyRef;
export type AdminAgentConnectorDependency = PlatformAgentConnectorDependencyRef;

/**
 * Client-editable dependency draft. `model` is `null` until an exact published provider/model is
 * resolved (revision + checksum come from the real AI catalog, never fabricated). Skills and
 * connectors carry exact published version/checksum references.
 */
export interface AdminAgentDraftDependencies {
  connectors: AdminAgentConnectorDependency[];
  model: AdminAgentModelDependency | null;
  skills: AdminAgentSkillDependency[];
}

/** Editable client view-model. Transport fields remain derived from the authoritative Zod contract. */
export interface AdminAgentDraft {
  config: PlatformAgentVersionConfig;
  dependencies: AdminAgentDraftDependencies;
  version: string;
}

/**
 * Test/alternate-adapter fallback. Production UI availability is injected from the authoritative
 * `platform.getCapabilities.managedResources.agents` snapshot; the singleton adapter stays closed.
 */
export interface AdminAgentsClientCapabilities {
  rollouts: boolean;
}

export interface AdminAgentsClient {
  appendVersion: (
    input: AdminPlatformAgentAppendVersionInput,
  ) => Promise<AdminPlatformAgentAppendVersionOutput>;
  archive: (input: AdminPlatformAgentArchiveInput) => Promise<AdminPlatformAgentArchiveOutput>;
  cancelRollout: (
    input: AdminPlatformAgentRolloutCancelInput,
  ) => Promise<AdminPlatformAgentRolloutCancelOutput>;
  capabilities: AdminAgentsClientCapabilities;
  create: (input: AdminPlatformAgentCreateInput) => Promise<AdminPlatformAgentCreateOutput>;
  delete: (input: AdminPlatformAgentDeleteInput) => Promise<AdminPlatformAgentDeleteOutput>;
  get: (input: AdminPlatformAgentGetInput) => Promise<AdminPlatformAgentGetOutput>;
  getDependents: (
    input: AdminPlatformAgentDependentsInput,
  ) => Promise<AdminPlatformAgentDependentsOutput>;
  getRollout: (
    input: AdminPlatformAgentRolloutGetInput,
  ) => Promise<AdminPlatformAgentRolloutGetOutput>;
  list: (input: AdminPlatformAgentListInput) => Promise<AdminPlatformAgentListOutput>;
  listAssignments: (
    input: AdminPlatformAgentAssignmentListInput,
  ) => Promise<AdminPlatformAgentAssignmentListOutput>;
  listRollouts: (
    input: AdminPlatformAgentRolloutListInput,
  ) => Promise<AdminPlatformAgentRolloutListOutput>;
  listVersions: (
    input: AdminPlatformAgentVersionsListInput,
  ) => Promise<AdminPlatformAgentVersionsListOutput>;
  previewAssignment: (
    input: AdminPlatformAgentAssignmentPreviewInput,
  ) => Promise<AdminPlatformAgentAssignmentPreviewOutput>;
  publish: (input: AdminPlatformAgentPublishInput) => Promise<AdminPlatformAgentPublishOutput>;
  removeAssignment: (
    input: AdminPlatformAgentAssignmentRemoveInput,
  ) => Promise<AdminPlatformAgentAssignmentRemoveOutput>;
  retryRollout: (
    input: AdminPlatformAgentRolloutRetryInput,
  ) => Promise<AdminPlatformAgentRolloutRetryOutput>;
  rollback: (input: AdminPlatformAgentRollbackInput) => Promise<AdminPlatformAgentRollbackOutput>;
  rollbackRollout: (
    input: AdminPlatformAgentRolloutRollbackInput,
  ) => Promise<AdminPlatformAgentRolloutRollbackOutput>;
  setDefaultInbox: (
    input: AdminPlatformAgentSetDefaultInboxInput,
  ) => Promise<AdminPlatformAgentSetDefaultInboxOutput>;
  startRollout: (
    input: AdminPlatformAgentRolloutStartInput,
  ) => Promise<AdminPlatformAgentRolloutStartOutput>;
  updateDraft: (
    input: AdminPlatformAgentUpdateDraftInput,
  ) => Promise<AdminPlatformAgentUpdateDraftOutput>;
  upsertAssignment: (
    input: AdminPlatformAgentAssignmentUpsertInput,
  ) => Promise<AdminPlatformAgentAssignmentUpsertOutput>;
  validateDependencies: (
    input: AdminPlatformAgentValidateDependenciesInput,
  ) => Promise<AdminPlatformAgentValidateDependenciesOutput>;
}
