/**
 * Strict Zod contracts for the managed AI catalog (admin + published).
 *
 * Implementation is split by subdomain under `./aiCatalog/`; this file is the stable
 * public barrel so existing `.../contracts/aiCatalog` import paths remain valid.
 */

export {
  BOUNDED_JSON_MAX_DEPTH,
  BOUNDED_JSON_MAX_KEYS_PER_OBJECT,
  BOUNDED_JSON_MAX_NODES,
  BOUNDED_JSON_MAX_SERIALIZED_BYTES,
} from './aiCatalog/boundedJson';
export {
  aiModelDraftSchema,
  type AiProviderDraft,
  aiProviderDraftSchema,
  type PublishedAiCatalog,
  publishedAiCatalogSchema,
  publishedAiModelSchema,
  type PublishedAiProvider,
  publishedAiProviderSchema,
} from './aiCatalog/drafts';
export {
  BOUNDED_HEADER_MAP_MAX_ENTRIES,
  BOUNDED_HEADER_NAME_MAX,
  BOUNDED_HEADER_VALUE_MAX,
  boundedHeaderMapSchema,
} from './aiCatalog/headers';
export {
  type AdminAiModelApplyImmediateInput,
  adminAiModelApplyImmediateInputSchema,
  adminAiModelApplyImmediateOutputSchema,
  adminAiModelCreateInputSchema,
  adminAiModelDeleteInputSchema,
  adminAiModelDependentsInputSchema,
  adminAiModelDependentsOutputSchema,
  adminAiModelListInputSchema,
  adminAiModelListItemSchema,
  adminAiModelListOutputSchema,
  adminAiModelReorderInputSchema,
  type AdminAiModelSyncUpstreamInput,
  adminAiModelSyncUpstreamInputSchema,
  type AdminAiModelSyncUpstreamOutput,
  adminAiModelSyncUpstreamOutputSchema,
  adminAiModelUpdateInputSchema,
} from './aiCatalog/models';
export {
  adminAiProviderApplyImmediateInputSchema,
  adminAiProviderApplyImmediateOutputSchema,
  adminAiProviderArchiveInputSchema,
  adminAiProviderCreateDraftInputSchema,
  adminAiProviderDeleteInputSchema,
  adminAiProviderDeleteOutputSchema,
  adminAiProviderGetBatchInputSchema,
  adminAiProviderGetBatchOutputSchema,
  adminAiProviderGetInputSchema,
  adminAiProviderGetOutputSchema,
  adminAiProviderListInputSchema,
  adminAiProviderListOutputSchema,
  adminAiProviderPublishInputSchema,
  adminAiProviderRevisionHistoryInputSchema,
  adminAiProviderRevisionHistoryOutputSchema,
  adminAiProviderRevisionOutputSchema,
  adminAiProviderRollbackInputSchema,
  adminAiProviderTestInputSchema,
  adminAiProviderUpdateDraftInputSchema,
} from './aiCatalog/providers';
export {
  AI_CONNECTION_TEST_ERROR_TYPES,
  type AiConnectionTestErrorType,
  aiConnectionTestResultSchema,
  aiConnectionTestStateSchema,
  aiSecretMutationSchema,
  aiSecretStateSchema,
} from './aiCatalog/secrets';
