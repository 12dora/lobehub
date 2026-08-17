import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { throwEnterpriseError } from '../../../guards/enterpriseErrors';

/** Stable machine-readable import failure reasons (client maps to i18n). */
export const SKILL_IMPORT_ERROR_REASONS = {
  CONTENT_TOO_LARGE: 'skill_import_content_too_large',
  FETCH_FAILED: 'skill_import_fetch_failed',
  INVALID_ZIP: 'skill_import_invalid_zip',
  NOT_FOUND: 'skill_import_not_found',
  PARSE_FAILED: 'skill_import_parse_failed',
  TIMEOUT: 'skill_import_timeout',
  ZIP_TOO_LARGE: 'skill_import_zip_too_large',
} as const;

export type SkillImportErrorReason =
  (typeof SKILL_IMPORT_ERROR_REASONS)[keyof typeof SKILL_IMPORT_ERROR_REASONS];

export const importError = (
  reason: SkillImportErrorReason,
  options?: { httpCode?: 'BAD_REQUEST' | 'NOT_FOUND'; status?: number },
): never => {
  const httpCode =
    options?.httpCode ??
    (reason === SKILL_IMPORT_ERROR_REASONS.NOT_FOUND ? 'NOT_FOUND' : 'BAD_REQUEST');
  const code =
    reason === SKILL_IMPORT_ERROR_REASONS.NOT_FOUND
      ? PLATFORM_ERROR_CODES.PLATFORM_NOT_FOUND
      : PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT;
  return throwEnterpriseError({
    code,
    details: {
      reason,
      ...(typeof options?.status === 'number' ? { status: options.status } : {}),
    },
    httpCode,
    message: reason,
  });
};
