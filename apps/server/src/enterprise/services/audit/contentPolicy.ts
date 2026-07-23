/**
 * Content access policy gate for conversation / message evidence.
 */

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformAuditContentAccessMode } from '@/database/schemas/platform';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';

export type ConversationContentAccess =
  | { mode: 'content_allowed'; allowBody: true }
  | { mode: 'disabled'; allowBody: false }
  | { mode: 'metadata_only'; allowBody: false };

export const resolveConversationContentAccess = (
  contentAccessMode: PlatformAuditContentAccessMode,
): ConversationContentAccess => {
  if (contentAccessMode === 'disabled') {
    return { allowBody: false, mode: 'disabled' };
  }
  if (contentAccessMode === 'content_allowed') {
    return { allowBody: true, mode: 'content_allowed' };
  }
  return { allowBody: false, mode: 'metadata_only' };
};

/** Deny all conversation surfaces when content access is disabled. */
export const assertConversationAccessEnabled = (
  contentAccessMode: PlatformAuditContentAccessMode,
): void => {
  if (contentAccessMode === 'disabled') {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
      details: { reason: 'audit_content_access_disabled' },
      httpCode: 'FORBIDDEN',
      message: 'Audit conversation content access is disabled by policy',
    });
  }
};
