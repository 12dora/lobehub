import { z } from 'zod';

import { httpHeaderNameSchema, httpHeaderValueSchema } from '../shared';

/** Hard bounds for credential / connector HTTP header maps. */
export const BOUNDED_HEADER_MAP_MAX_ENTRIES = 50;
export const BOUNDED_HEADER_NAME_MAX = 200;
export const BOUNDED_HEADER_VALUE_MAX = 8192;

const boundedHeaderNameSchema = httpHeaderNameSchema.max(BOUNDED_HEADER_NAME_MAX);
const boundedHeaderValueSchema = httpHeaderValueSchema.max(BOUNDED_HEADER_VALUE_MAX);

/**
 * Write-time header-map schema: entry cap, RFC 9110 field-name tokens, bounded
 * values, no control chars. Used only by secret *mutations* (`aiSecretMutationSchema`).
 *
 * Already-persisted vaults are NOT revalidated with this grammar on read —
 * `AiCatalogSecretManager.decrypt` accepts any string-keyed customHeaders map so
 * admins can load and correct providers that predate the token rule via
 * keep/merge/replace (accept-on-read, reject-on-write). Detail APIs remain
 * presence-only — secret values are not projected for display.
 */
export const boundedHeaderMapSchema = z
  .record(boundedHeaderNameSchema, boundedHeaderValueSchema)
  .superRefine((value, ctx) => {
    if (Object.keys(value).length > BOUNDED_HEADER_MAP_MAX_ENTRIES) {
      ctx.addIssue({
        code: 'custom',
        message: `header map exceeds max entry count of ${BOUNDED_HEADER_MAP_MAX_ENTRIES}`,
      });
    }
  });
