import type {
  PlatformAgentConnectorDependencyRef,
  PlatformAgentModelDependencyRef,
  PlatformAgentSkillDependencyRef,
  PlatformAgentVersionConfig,
} from '@lobechat/types';

import type {
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
  AdminPlatformAgentSaveInput,
  AdminPlatformAgentSaveOutput,
  AdminPlatformAgentSetDefaultInboxInput,
  AdminPlatformAgentSetDefaultInboxOutput,
  AdminPlatformAgentValidateDependenciesInput,
  AdminPlatformAgentValidateDependenciesOutput,
  AdminPlatformAgentVersionsListInput,
  AdminPlatformAgentVersionsListOutput,
} from '@/server/enterprise/contracts/platformAgents';

export type {
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
  AdminPlatformAgentSaveInput,
  AdminPlatformAgentSaveOutput,
  AdminPlatformAgentSetDefaultInboxInput,
  AdminPlatformAgentSetDefaultInboxOutput,
  AdminPlatformAgentValidateDependenciesInput,
  AdminPlatformAgentValidateDependenciesOutput,
  AdminPlatformAgentVersionsListInput,
  AdminPlatformAgentVersionsListOutput,
};

/**
 * Take over the platform default assistant: the server creates the `default-inbox` Agent and its
 * mandatory global assignment in one transaction, seeding the copy from `locale`.
 *
 * Declared here rather than re-exported from the server contracts so the client compiles against
 * the agreed shape independently of when the procedure lands.
 */
export interface AdminPlatformAgentProvisionDefaultInboxInput {
  /** UI language the seeded name / prompt / opening message are written in. */
  locale?: string;
}

/** Same aggregate root `get` returns — the freshly provisioned default, ready to edit. */
export type AdminPlatformAgentProvisionDefaultInboxOutput = AdminPlatformAgentGetOutput;

export type AdminAgentListInput = AdminPlatformAgentListInput;
export type AdminAgentListItem = AdminPlatformAgentListOutput['items'][number];
export type AdminAgentListOutput = AdminPlatformAgentListOutput;
export type AdminAgentAssignmentPreviewOutput = AdminPlatformAgentAssignmentPreviewOutput;

/** Completeness of the client-drained subcollections on a detail aggregate. */
export interface AdminAgentCollectionMeta {
  assignmentsNextCursor: string | null;
  assignmentsTruncated: boolean;
  rolloutsNextCursor: string | null;
  rolloutsTruncated: boolean;
  versionsNextCursor: string | null;
  versionsTruncated: boolean;
}

/** Client-only aggregate assembled from the independently paged endpoint outputs. */
export interface AdminAgentDetailOutput extends AdminPlatformAgentGetOutput {
  assignments: AdminPlatformAgentAssignmentListOutput['items'];
  /** Present when the aggregate drain reports whether any subcollection was truncated. */
  collectionMeta?: AdminAgentCollectionMeta;
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

/**
 * Editable client view-model for the assistant editor modal. There is no local draft lifecycle:
 * the value lives only while the modal is open, and saving publishes it immediately. The version
 * label is generated by the server, so it is not part of the editable value.
 */
export interface AdminAgentEditorValue {
  config: PlatformAgentVersionConfig;
  dependencies: AdminAgentDraftDependencies;
}

/**
 * Test/alternate-adapter fallback. Production UI availability is injected from the authoritative
 * `platform.getCapabilities.managedResources.agents` snapshot; the singleton adapter stays closed.
 */
export interface AdminAgentsClientCapabilities {
  rollouts: boolean;
}

export interface AdminAgentsClient {
  archive: (input: AdminPlatformAgentArchiveInput) => Promise<AdminPlatformAgentArchiveOutput>;
  cancelRollout: (
    input: AdminPlatformAgentRolloutCancelInput,
  ) => Promise<AdminPlatformAgentRolloutCancelOutput>;
  capabilities: AdminAgentsClientCapabilities;
  create: (input: AdminPlatformAgentCreateInput) => Promise<AdminPlatformAgentCreateOutput>;
  delete: (input: AdminPlatformAgentDeleteInput) => Promise<AdminPlatformAgentDeleteOutput>;
  get: (input: AdminPlatformAgentGetInput) => Promise<AdminPlatformAgentGetOutput>;
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
  /** Create the managed `default-inbox` Agent plus its mandatory global assignment. */
  provisionDefaultInbox: (
    input: AdminPlatformAgentProvisionDefaultInboxInput,
  ) => Promise<AdminPlatformAgentProvisionDefaultInboxOutput>;
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
  /** Append an immutable version AND publish it in one server transaction. */
  save: (input: AdminPlatformAgentSaveInput) => Promise<AdminPlatformAgentSaveOutput>;
  setDefaultInbox: (
    input: AdminPlatformAgentSetDefaultInboxInput,
  ) => Promise<AdminPlatformAgentSetDefaultInboxOutput>;
  startRollout: (
    input: AdminPlatformAgentRolloutStartInput,
  ) => Promise<AdminPlatformAgentRolloutStartOutput>;
  upsertAssignment: (
    input: AdminPlatformAgentAssignmentUpsertInput,
  ) => Promise<AdminPlatformAgentAssignmentUpsertOutput>;
}
