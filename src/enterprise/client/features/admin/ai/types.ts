import type { z } from 'zod';

import type {
  adminAiModelListInputSchema,
  adminAiModelListOutputSchema,
  adminAiProviderDeleteInputSchema,
  adminAiProviderDeleteOutputSchema,
  adminAiProviderGetBatchInputSchema,
  adminAiProviderGetBatchOutputSchema,
  adminAiProviderGetInputSchema,
  adminAiProviderGetOutputSchema,
  adminAiProviderListInputSchema,
  adminAiProviderListOutputSchema,
  adminAiProviderRevisionHistoryInputSchema,
  adminAiProviderRevisionHistoryOutputSchema,
} from '@/server/enterprise/contracts/aiCatalog';

export type AdminAiModelListInput = z.infer<typeof adminAiModelListInputSchema>;
export type AdminAiModelListOutput = z.infer<typeof adminAiModelListOutputSchema>;
export type AdminAiProviderDeleteInput = z.infer<typeof adminAiProviderDeleteInputSchema>;
export type AdminAiProviderDeleteOutput = z.infer<typeof adminAiProviderDeleteOutputSchema>;
export type AdminAiProviderGetInput = z.infer<typeof adminAiProviderGetInputSchema>;
export type AdminAiProviderGetOutput = z.infer<typeof adminAiProviderGetOutputSchema>;
export type AdminAiProviderGetBatchInput = z.infer<typeof adminAiProviderGetBatchInputSchema>;
export type AdminAiProviderGetBatchOutput = z.infer<typeof adminAiProviderGetBatchOutputSchema>;
export type AdminAiProviderListInput = z.infer<typeof adminAiProviderListInputSchema>;
export type AdminAiProviderListOutput = z.infer<typeof adminAiProviderListOutputSchema>;
export type AdminAiProviderRevisionHistoryInput = z.infer<
  typeof adminAiProviderRevisionHistoryInputSchema
>;
export type AdminAiProviderRevisionHistoryOutput = z.infer<
  typeof adminAiProviderRevisionHistoryOutputSchema
>;

export type AdminAiProviderListItem = AdminAiProviderListOutput['items'][number];
export type AdminAiProviderDraft = AdminAiProviderGetOutput['draft'];
export type AdminAiModelDraft = AdminAiProviderDraft['models'][number];
export type AdminAiModelListItem = AdminAiModelListOutput['items'][number];
