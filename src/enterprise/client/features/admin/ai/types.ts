import type { z } from 'zod';

import type {
  adminAiModelCreateInputSchema,
  adminAiModelCreateTargetListInputSchema,
  adminAiModelCreateTargetListOutputSchema,
  adminAiModelDeleteInputSchema,
  adminAiModelDeleteOutputSchema,
  adminAiModelDependentsInputSchema,
  adminAiModelDependentsOutputSchema,
  adminAiModelDraftContextInputSchema,
  adminAiModelDraftContextOutputSchema,
  adminAiModelListInputSchema,
  adminAiModelListOutputSchema,
  adminAiModelMutationOutputSchema,
  adminAiModelReorderInputSchema,
  adminAiModelReorderOutputSchema,
  adminAiModelUpdateInputSchema,
  adminAiProviderArchiveInputSchema,
  adminAiProviderCreateDraftInputSchema,
  adminAiProviderGetInputSchema,
  adminAiProviderGetOutputSchema,
  adminAiProviderListInputSchema,
  adminAiProviderListOutputSchema,
  adminAiProviderMutationOutputSchema,
  adminAiProviderPublishInputSchema,
  adminAiProviderRevisionHistoryInputSchema,
  adminAiProviderRevisionHistoryOutputSchema,
  adminAiProviderRevisionOutputSchema,
  adminAiProviderRollbackInputSchema,
  adminAiProviderTestInputSchema,
  adminAiProviderUpdateDraftInputSchema,
  aiConnectionTestResultSchema,
  aiConnectionTestStateSchema,
  aiSecretMutationSchema,
} from '@/server/enterprise/contracts/aiCatalog';

export type AdminAiModelCreateInput = z.infer<typeof adminAiModelCreateInputSchema>;
export type AdminAiModelCreateTargetListInput = z.infer<
  typeof adminAiModelCreateTargetListInputSchema
>;
export type AdminAiModelCreateTargetListOutput = z.infer<
  typeof adminAiModelCreateTargetListOutputSchema
>;
export type AdminAiModelDeleteInput = z.infer<typeof adminAiModelDeleteInputSchema>;
export type AdminAiModelDeleteOutput = z.infer<typeof adminAiModelDeleteOutputSchema>;
export type AdminAiModelDraftContextInput = z.infer<typeof adminAiModelDraftContextInputSchema>;
export type AdminAiModelDraftContextOutput = z.infer<typeof adminAiModelDraftContextOutputSchema>;
export type AdminAiModelDependentsInput = z.infer<typeof adminAiModelDependentsInputSchema>;
export type AdminAiModelDependentsOutput = z.infer<typeof adminAiModelDependentsOutputSchema>;
export type AdminAiModelListInput = z.infer<typeof adminAiModelListInputSchema>;
export type AdminAiModelListOutput = z.infer<typeof adminAiModelListOutputSchema>;
export type AdminAiModelMutationOutput = z.infer<typeof adminAiModelMutationOutputSchema>;
export type AdminAiModelReorderInput = z.infer<typeof adminAiModelReorderInputSchema>;
export type AdminAiModelReorderOutput = z.infer<typeof adminAiModelReorderOutputSchema>;
export type AdminAiModelUpdateInput = z.infer<typeof adminAiModelUpdateInputSchema>;
export type AdminAiProviderArchiveInput = z.infer<typeof adminAiProviderArchiveInputSchema>;
export type AdminAiProviderCreateDraftInput = z.infer<typeof adminAiProviderCreateDraftInputSchema>;
export type AdminAiProviderGetInput = z.infer<typeof adminAiProviderGetInputSchema>;
export type AdminAiProviderGetOutput = z.infer<typeof adminAiProviderGetOutputSchema>;
export type AdminAiProviderListInput = z.infer<typeof adminAiProviderListInputSchema>;
export type AdminAiProviderListOutput = z.infer<typeof adminAiProviderListOutputSchema>;
export type AdminAiProviderMutationOutput = z.infer<typeof adminAiProviderMutationOutputSchema>;
export type AdminAiProviderPublishInput = z.infer<typeof adminAiProviderPublishInputSchema>;
export type AdminAiProviderRevisionOutput = z.infer<typeof adminAiProviderRevisionOutputSchema>;
export type AdminAiProviderRevisionHistoryInput = z.infer<
  typeof adminAiProviderRevisionHistoryInputSchema
>;
export type AdminAiProviderRevisionHistoryOutput = z.infer<
  typeof adminAiProviderRevisionHistoryOutputSchema
>;
export type AdminAiProviderRollbackInput = z.infer<typeof adminAiProviderRollbackInputSchema>;
export type AdminAiProviderTestInput = z.infer<typeof adminAiProviderTestInputSchema>;
export type AdminAiProviderUpdateDraftInput = z.infer<typeof adminAiProviderUpdateDraftInputSchema>;
export type AiConnectionTestResult = z.infer<typeof aiConnectionTestResultSchema>;
export type AiConnectionTestState = z.infer<typeof aiConnectionTestStateSchema>;
export type AiSecretMutation = z.infer<typeof aiSecretMutationSchema>;

export type AdminAiProviderListItem = AdminAiProviderListOutput['items'][number];
export type AdminAiProviderDraft = AdminAiProviderGetOutput['draft'];
export type AdminAiModelDraft = AdminAiProviderDraft['models'][number];
export type AdminAiModelListItem = AdminAiModelListOutput['items'][number];
