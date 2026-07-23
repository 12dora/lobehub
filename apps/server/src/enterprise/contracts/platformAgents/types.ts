import type { z } from 'zod';

import type {
  adminPlatformAgentAppendVersionInputSchema,
  adminPlatformAgentAppendVersionOutputSchema,
  adminPlatformAgentArchiveInputSchema,
  adminPlatformAgentArchiveOutputSchema,
  adminPlatformAgentCreateInputSchema,
  adminPlatformAgentCreateOutputSchema,
  adminPlatformAgentDeleteInputSchema,
  adminPlatformAgentDeleteOutputSchema,
  adminPlatformAgentDependentsInputSchema,
  adminPlatformAgentDependentsOutputSchema,
  adminPlatformAgentGetInputSchema,
  adminPlatformAgentGetOutputSchema,
  adminPlatformAgentListInputSchema,
  adminPlatformAgentListOutputSchema,
  adminPlatformAgentMutationOutputSchema,
  adminPlatformAgentPublishInputSchema,
  adminPlatformAgentPublishOutputSchema,
  adminPlatformAgentRollbackInputSchema,
  adminPlatformAgentRollbackOutputSchema,
  adminPlatformAgentSetDefaultInboxInputSchema,
  adminPlatformAgentSetDefaultInboxOutputSchema,
  adminPlatformAgentUpdateDraftInputSchema,
  adminPlatformAgentUpdateDraftOutputSchema,
  adminPlatformAgentValidateDependenciesInputSchema,
  adminPlatformAgentValidateDependenciesOutputSchema,
  adminPlatformAgentVersionsListInputSchema,
  adminPlatformAgentVersionsListOutputSchema,
} from './adminLifecycle';
import type {
  adminPlatformAgentAssignmentCreateInputSchema,
  adminPlatformAgentAssignmentListInputSchema,
  adminPlatformAgentAssignmentListOutputSchema,
  adminPlatformAgentAssignmentPreviewInputSchema,
  adminPlatformAgentAssignmentPreviewOutputSchema,
  adminPlatformAgentAssignmentRemoveInputSchema,
  adminPlatformAgentAssignmentRemoveOutputSchema,
  adminPlatformAgentAssignmentUpsertInputSchema,
  adminPlatformAgentAssignmentUpsertOutputSchema,
} from './assignments';
import type {
  platformAgentEffectiveGetInputSchema,
  platformAgentEffectiveGetOutputSchema,
  platformAgentEffectiveListOutputSchema,
} from './effective';
import type {
  adminPlatformAgentDetailAggregateOutputSchema,
  adminPlatformAgentRolloutCancelInputSchema,
  adminPlatformAgentRolloutCancelOutputSchema,
  adminPlatformAgentRolloutGetInputSchema,
  adminPlatformAgentRolloutGetOutputSchema,
  adminPlatformAgentRolloutListInputSchema,
  adminPlatformAgentRolloutListOutputSchema,
  adminPlatformAgentRolloutMutationInputSchema,
  adminPlatformAgentRolloutRetryInputSchema,
  adminPlatformAgentRolloutRetryOutputSchema,
  adminPlatformAgentRolloutRollbackInputSchema,
  adminPlatformAgentRolloutRollbackOutputSchema,
  adminPlatformAgentRolloutStartInputSchema,
  adminPlatformAgentRolloutStartOutputSchema,
} from './rollout';

export type AdminPlatformAgentAppendVersionInput = z.input<
  typeof adminPlatformAgentAppendVersionInputSchema
>;
export type AdminPlatformAgentAppendVersionOutput = z.output<
  typeof adminPlatformAgentAppendVersionOutputSchema
>;
export type AdminPlatformAgentArchiveInput = z.input<typeof adminPlatformAgentArchiveInputSchema>;
export type AdminPlatformAgentArchiveOutput = z.output<
  typeof adminPlatformAgentArchiveOutputSchema
>;
export type AdminPlatformAgentDeleteInput = z.input<typeof adminPlatformAgentDeleteInputSchema>;
export type AdminPlatformAgentDeleteOutput = z.output<typeof adminPlatformAgentDeleteOutputSchema>;
export type AdminPlatformAgentAssignmentCreateInput = z.input<
  typeof adminPlatformAgentAssignmentCreateInputSchema
>;
export type AdminPlatformAgentAssignmentListInput = z.input<
  typeof adminPlatformAgentAssignmentListInputSchema
>;
export type AdminPlatformAgentAssignmentListOutput = z.output<
  typeof adminPlatformAgentAssignmentListOutputSchema
>;
export type AdminPlatformAgentAssignmentPreviewInput = z.input<
  typeof adminPlatformAgentAssignmentPreviewInputSchema
>;
export type AdminPlatformAgentAssignmentPreviewOutput = z.output<
  typeof adminPlatformAgentAssignmentPreviewOutputSchema
>;
export type AdminPlatformAgentAssignmentRemoveInput = z.input<
  typeof adminPlatformAgentAssignmentRemoveInputSchema
>;
export type AdminPlatformAgentAssignmentRemoveOutput = z.output<
  typeof adminPlatformAgentAssignmentRemoveOutputSchema
>;
export type AdminPlatformAgentAssignmentUpsertInput = z.input<
  typeof adminPlatformAgentAssignmentUpsertInputSchema
>;
export type AdminPlatformAgentAssignmentUpsertOutput = z.output<
  typeof adminPlatformAgentAssignmentUpsertOutputSchema
>;
export type AdminPlatformAgentCreateInput = z.input<typeof adminPlatformAgentCreateInputSchema>;
export type AdminPlatformAgentCreateOutput = z.output<typeof adminPlatformAgentCreateOutputSchema>;
export type AdminPlatformAgentDependentsInput = z.input<
  typeof adminPlatformAgentDependentsInputSchema
>;
export type AdminPlatformAgentDependentsOutput = z.output<
  typeof adminPlatformAgentDependentsOutputSchema
>;
export type AdminPlatformAgentGetInput = z.input<typeof adminPlatformAgentGetInputSchema>;
export type AdminPlatformAgentGetOutput = z.output<typeof adminPlatformAgentGetOutputSchema>;
export type AdminPlatformAgentDetailAggregateOutput = z.output<
  typeof adminPlatformAgentDetailAggregateOutputSchema
>;
export type AdminPlatformAgentListInput = z.input<typeof adminPlatformAgentListInputSchema>;
export type AdminPlatformAgentListOutput = z.output<typeof adminPlatformAgentListOutputSchema>;
export type AdminPlatformAgentMutationOutput = z.output<
  typeof adminPlatformAgentMutationOutputSchema
>;
export type AdminPlatformAgentPublishInput = z.input<typeof adminPlatformAgentPublishInputSchema>;
export type AdminPlatformAgentPublishOutput = z.output<
  typeof adminPlatformAgentPublishOutputSchema
>;
export type AdminPlatformAgentRollbackInput = z.input<typeof adminPlatformAgentRollbackInputSchema>;
export type AdminPlatformAgentRollbackOutput = z.output<
  typeof adminPlatformAgentRollbackOutputSchema
>;
export type AdminPlatformAgentRolloutCancelInput = z.input<
  typeof adminPlatformAgentRolloutCancelInputSchema
>;
export type AdminPlatformAgentRolloutCancelOutput = z.output<
  typeof adminPlatformAgentRolloutCancelOutputSchema
>;
export type AdminPlatformAgentRolloutGetInput = z.input<
  typeof adminPlatformAgentRolloutGetInputSchema
>;
export type AdminPlatformAgentRolloutGetOutput = z.output<
  typeof adminPlatformAgentRolloutGetOutputSchema
>;
export type AdminPlatformAgentRolloutListInput = z.input<
  typeof adminPlatformAgentRolloutListInputSchema
>;
export type AdminPlatformAgentRolloutListOutput = z.output<
  typeof adminPlatformAgentRolloutListOutputSchema
>;
export type AdminPlatformAgentRolloutMutationInput = z.input<
  typeof adminPlatformAgentRolloutMutationInputSchema
>;
export type AdminPlatformAgentRolloutRetryInput = z.input<
  typeof adminPlatformAgentRolloutRetryInputSchema
>;
export type AdminPlatformAgentRolloutRetryOutput = z.output<
  typeof adminPlatformAgentRolloutRetryOutputSchema
>;
export type AdminPlatformAgentRolloutRollbackInput = z.input<
  typeof adminPlatformAgentRolloutRollbackInputSchema
>;
export type AdminPlatformAgentRolloutRollbackOutput = z.output<
  typeof adminPlatformAgentRolloutRollbackOutputSchema
>;
export type AdminPlatformAgentRolloutStartInput = z.input<
  typeof adminPlatformAgentRolloutStartInputSchema
>;
export type AdminPlatformAgentRolloutStartOutput = z.output<
  typeof adminPlatformAgentRolloutStartOutputSchema
>;
export type AdminPlatformAgentSetDefaultInboxInput = z.input<
  typeof adminPlatformAgentSetDefaultInboxInputSchema
>;
export type AdminPlatformAgentSetDefaultInboxOutput = z.output<
  typeof adminPlatformAgentSetDefaultInboxOutputSchema
>;
export type AdminPlatformAgentUpdateDraftInput = z.input<
  typeof adminPlatformAgentUpdateDraftInputSchema
>;
export type AdminPlatformAgentUpdateDraftOutput = z.output<
  typeof adminPlatformAgentUpdateDraftOutputSchema
>;
export type AdminPlatformAgentValidateDependenciesInput = z.input<
  typeof adminPlatformAgentValidateDependenciesInputSchema
>;
export type AdminPlatformAgentValidateDependenciesOutput = z.output<
  typeof adminPlatformAgentValidateDependenciesOutputSchema
>;
export type AdminPlatformAgentVersionsListInput = z.input<
  typeof adminPlatformAgentVersionsListInputSchema
>;
export type AdminPlatformAgentVersionsListOutput = z.output<
  typeof adminPlatformAgentVersionsListOutputSchema
>;
export type PlatformAgentEffectiveGetInput = z.input<typeof platformAgentEffectiveGetInputSchema>;
export type PlatformAgentEffectiveGetOutput = z.output<
  typeof platformAgentEffectiveGetOutputSchema
>;
export type PlatformAgentEffectiveListOutput = z.output<
  typeof platformAgentEffectiveListOutputSchema
>;
