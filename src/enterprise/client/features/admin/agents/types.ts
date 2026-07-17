import type {
  PlatformAgentAssignment,
  PlatformAgentDependencySnapshot,
  PlatformAgentIdentityDraft,
  PlatformAgentImmutableVersion,
  PlatformAgentRolloutProjection,
  PlatformAgentVersionConfig,
} from '@lobechat/types';

import type {
  AdminPlatformAgentAppendVersionInput,
  AdminPlatformAgentAssignmentCreateInput,
  AdminPlatformAgentCreateInput,
} from '@/server/enterprise/contracts/platformAgents';

export type {
  AdminPlatformAgentAppendVersionInput,
  AdminPlatformAgentAssignmentCreateInput,
  AdminPlatformAgentCreateInput,
};

export interface AdminAgentListInput {
  query?: string;
  status?: PlatformAgentIdentityDraft['status'];
}

export interface AdminAgentListItem extends PlatformAgentIdentityDraft {
  assignmentCount: number;
  displayName: string;
  publishedVersion: string | null;
}

export interface AdminAgentListOutput {
  items: AdminAgentListItem[];
}

export interface AdminAgentDetailOutput {
  assignments: PlatformAgentAssignment[];
  draftToken: string;
  identity: PlatformAgentIdentityDraft;
  rollouts: PlatformAgentRolloutProjection[];
  versions: PlatformAgentImmutableVersion[];
}

export interface AdminAgentMutationOutput {
  draftToken: string;
  identity: PlatformAgentIdentityDraft;
}

export interface AdminAgentPublishInput {
  agentId: string;
  expectedRevision: number;
  reason: string;
  versionId: string;
}

export interface AdminAgentRollbackInput extends AdminAgentPublishInput {}

export interface AdminAgentArchiveInput {
  agentId: string;
  expectedRevision: number;
  reason: string;
}

export interface AdminAgentAssignmentDeleteInput {
  agentId: string;
  assignmentId: string;
  reason: string;
}

export interface AdminAgentAssignmentPreviewInput {
  agentId: string;
  assignment: Omit<AdminPlatformAgentAssignmentCreateInput, 'agentId' | 'reason'>;
}

export interface AdminAgentAssignmentPreviewOutput {
  estimatedUsers: number;
  warnings: string[];
}

export interface AdminAgentRolloutInput {
  agentId: string;
  assignmentId: string;
}

export interface AdminAgentRolloutMutationInput extends AdminAgentRolloutInput {
  jobId: string;
}

export interface AdminAgentDraft {
  config: PlatformAgentVersionConfig;
  dependencySnapshot: PlatformAgentDependencySnapshot;
  version: string;
}

/** UI boundary: production TRPC and deterministic mocks implement the same contract. */
export interface AdminAgentsClient {
  appendVersion: (input: AdminPlatformAgentAppendVersionInput) => Promise<AdminAgentMutationOutput>;
  archive: (input: AdminAgentArchiveInput) => Promise<AdminAgentMutationOutput>;
  cancelRollout: (input: AdminAgentRolloutMutationInput) => Promise<PlatformAgentRolloutProjection>;
  create: (input: AdminPlatformAgentCreateInput) => Promise<AdminAgentMutationOutput>;
  createAssignment: (
    input: AdminPlatformAgentAssignmentCreateInput,
  ) => Promise<PlatformAgentAssignment>;
  deleteAssignment: (input: AdminAgentAssignmentDeleteInput) => Promise<void>;
  get: (input: { id: string }) => Promise<AdminAgentDetailOutput>;
  list: (input: AdminAgentListInput) => Promise<AdminAgentListOutput>;
  previewAssignment: (
    input: AdminAgentAssignmentPreviewInput,
  ) => Promise<AdminAgentAssignmentPreviewOutput>;
  publish: (input: AdminAgentPublishInput) => Promise<AdminAgentMutationOutput>;
  retryRollout: (
    input: AdminAgentRolloutMutationInput,
  ) => Promise<PlatformAgentRolloutProjection>;
  rollback: (input: AdminAgentRollbackInput) => Promise<AdminAgentMutationOutput>;
  startRollout: (input: AdminAgentRolloutInput) => Promise<PlatformAgentRolloutProjection>;
}
