import type { z } from 'zod';

import type {
  adminAiModelCreateInputSchema,
  adminAiModelDeleteInputSchema,
  adminAiModelDependentsInputSchema,
  adminAiModelDependentsOutputSchema,
  adminAiModelListInputSchema,
  adminAiModelListOutputSchema,
  adminAiModelReorderInputSchema,
  adminAiModelUpdateInputSchema,
  adminAiProviderArchiveInputSchema,
  adminAiProviderCreateDraftInputSchema,
  adminAiProviderGetInputSchema,
  adminAiProviderGetOutputSchema,
  adminAiProviderListInputSchema,
  adminAiProviderListOutputSchema,
  adminAiProviderPublishInputSchema,
  adminAiProviderRevisionOutputSchema,
  adminAiProviderRollbackInputSchema,
  adminAiProviderTestInputSchema,
  adminAiProviderUpdateDraftInputSchema,
  aiConnectionTestResultSchema,
} from '@/server/enterprise/contracts/aiCatalog';

export type AdminAiModelCreateInput = z.infer<typeof adminAiModelCreateInputSchema>;
export type AdminAiModelDeleteInput = z.infer<typeof adminAiModelDeleteInputSchema>;
export type AdminAiModelDependentsInput = z.infer<typeof adminAiModelDependentsInputSchema>;
export type AdminAiModelDependentsOutput = z.infer<typeof adminAiModelDependentsOutputSchema>;
export type AdminAiModelListInput = z.infer<typeof adminAiModelListInputSchema>;
export type AdminAiModelListOutput = z.infer<typeof adminAiModelListOutputSchema>;
export type AdminAiModelReorderInput = z.infer<typeof adminAiModelReorderInputSchema>;
export type AdminAiModelUpdateInput = z.infer<typeof adminAiModelUpdateInputSchema>;
export type AdminAiProviderArchiveInput = z.infer<typeof adminAiProviderArchiveInputSchema>;
export type AdminAiProviderCreateDraftInput = z.infer<typeof adminAiProviderCreateDraftInputSchema>;
export type AdminAiProviderGetInput = z.infer<typeof adminAiProviderGetInputSchema>;
export type AdminAiProviderGetOutput = z.infer<typeof adminAiProviderGetOutputSchema>;
export type AdminAiProviderListInput = z.infer<typeof adminAiProviderListInputSchema>;
export type AdminAiProviderListOutput = z.infer<typeof adminAiProviderListOutputSchema>;
export type AdminAiProviderPublishInput = z.infer<typeof adminAiProviderPublishInputSchema>;
export type AdminAiProviderRevisionOutput = z.infer<typeof adminAiProviderRevisionOutputSchema>;
export type AdminAiProviderRollbackInput = z.infer<typeof adminAiProviderRollbackInputSchema>;
export type AdminAiProviderTestInput = z.infer<typeof adminAiProviderTestInputSchema>;
export type AdminAiProviderUpdateDraftInput = z.infer<typeof adminAiProviderUpdateDraftInputSchema>;
export type AiConnectionTestResult = z.infer<typeof aiConnectionTestResultSchema>;

export type AdminAiProviderListItem = AdminAiProviderListOutput['items'][number];
export type AdminAiProviderDraft = AdminAiProviderGetOutput['draft'];
export type AdminAiModelDraft = AdminAiProviderDraft['models'][number];
export type AdminAiModelListItem = AdminAiModelListOutput['items'][number];
