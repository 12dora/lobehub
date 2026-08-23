import { z } from 'zod';

import {
  contentModerationRecordSchema,
  contentModerationSettingsViewSchema,
} from '@/types/platform/contentModeration';

import { RECORDS_DELETE_MAX } from './contentModerationSupport';

export const publishedCatalogProviderSchema = z
  .object({
    models: z.array(
      z
        .object({
          displayName: z.string(),
          id: z.string(),
        })
        .strict(),
    ),
    provider: z.string(),
    providerName: z.string(),
  })
  .strict();

export const getSettingsOutputSchema = z
  .object({
    catalog: z.array(publishedCatalogProviderSchema),
    roles: z.array(
      z
        .object({
          displayName: z.string().optional(),
          name: z.string(),
        })
        .strict(),
    ),
    settings: contentModerationSettingsViewSchema,
  })
  .strict();

export const getRecordOutputSchema = contentModerationRecordSchema
  .extend({
    user: z
      .object({
        avatar: z.string().nullable(),
        email: z.string().nullable(),
        fullName: z.string().nullable(),
        username: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const idInputSchema = z.object({ id: z.string().min(1) }).strict();

export const deleteRecordsInputSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(RECORDS_DELETE_MAX),
  })
  .strict();

export const revealOutputSchema = z
  .object({
    prompt: z.string().nullable(),
  })
  .strict();

export const deleteRecordsOutputSchema = z
  .object({
    deleted: z.number().int().min(0),
  })
  .strict();

export const clearCacheOutputSchema = z
  .object({
    deleted: z.number().int().min(0),
  })
  .strict();
