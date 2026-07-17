import type { z } from 'zod';

import type {
  adminSkillArchiveInputSchema,
  adminSkillCreateInputSchema,
  adminSkillCreateVersionInputSchema,
  adminSkillCreateVersionOutputSchema,
  adminSkillGetDependentsInputSchema,
  adminSkillGetDependentsOutputSchema,
  adminSkillGetInputSchema,
  adminSkillGetOutputSchema,
  adminSkillGetVersionInputSchema,
  adminSkillGetVersionOutputSchema,
  adminSkillListInputSchema,
  adminSkillListOutputSchema,
  adminSkillListVersionsInputSchema,
  adminSkillListVersionsOutputSchema,
  adminSkillMutationOutputSchema,
  adminSkillPublicationOutputSchema,
  adminSkillPublishInputSchema,
  adminSkillRollbackInputSchema,
  adminSkillUpdateDraftInputSchema,
  adminSkillValidateInputSchema,
  adminSkillValidateOutputSchema,
  publishedSkillCatalogSchema,
} from '@/server/enterprise/contracts/skillCatalog';

export type AdminSkillArchiveInput = z.infer<typeof adminSkillArchiveInputSchema>;
export type AdminSkillCreateInput = z.infer<typeof adminSkillCreateInputSchema>;
export type AdminSkillCreateVersionInput = z.infer<typeof adminSkillCreateVersionInputSchema>;
export type AdminSkillCreateVersionOutput = z.infer<typeof adminSkillCreateVersionOutputSchema>;
export type AdminSkillGetDependentsInput = z.infer<typeof adminSkillGetDependentsInputSchema>;
export type AdminSkillGetDependentsOutput = z.infer<typeof adminSkillGetDependentsOutputSchema>;
export type AdminSkillGetInput = z.infer<typeof adminSkillGetInputSchema>;
export type AdminSkillGetOutput = z.infer<typeof adminSkillGetOutputSchema>;
export type AdminSkillGetVersionInput = z.infer<typeof adminSkillGetVersionInputSchema>;
export type AdminSkillGetVersionOutput = z.infer<typeof adminSkillGetVersionOutputSchema>;
export type AdminSkillListInput = z.infer<typeof adminSkillListInputSchema>;
export type AdminSkillListOutput = z.infer<typeof adminSkillListOutputSchema>;
export type AdminSkillListVersionsInput = z.infer<typeof adminSkillListVersionsInputSchema>;
export type AdminSkillListVersionsOutput = z.infer<typeof adminSkillListVersionsOutputSchema>;
export type AdminSkillMutationOutput = z.infer<typeof adminSkillMutationOutputSchema>;
export type AdminSkillPublicationOutput = z.infer<typeof adminSkillPublicationOutputSchema>;
export type AdminSkillPublishInput = z.infer<typeof adminSkillPublishInputSchema>;
export type AdminSkillRollbackInput = z.infer<typeof adminSkillRollbackInputSchema>;
export type AdminSkillUpdateDraftInput = z.infer<typeof adminSkillUpdateDraftInputSchema>;
export type AdminSkillValidateInput = z.infer<typeof adminSkillValidateInputSchema>;
export type AdminSkillValidateOutput = z.infer<typeof adminSkillValidateOutputSchema>;
export type PublishedSkillCatalog = z.infer<typeof publishedSkillCatalogSchema>;

export type AdminSkillListItem = AdminSkillListOutput['items'][number];
export type AdminSkillVersionSummary = AdminSkillListVersionsOutput['items'][number];
export type PublishedSkill = PublishedSkillCatalog['skills'][number];
