import type { ModerationCategory } from '@/const/platform/contentModeration';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

export interface ContentModerationBlockedBody {
  category?: ModerationCategory | string;
  /** Omitted when the admin left `blockMessage` empty — client uses locale copy. */
  message?: string;
  recordId?: string;
}

/**
 * Thrown from the moderation-aware runtime when the effective action is `block`.
 * The chat webapi route maps `errorType` onto HTTP 403 + this body (B2 ↔ B5).
 */
export class ContentModerationBlockedError extends Error {
  readonly category?: ModerationCategory | string;
  readonly code = PLATFORM_ERROR_CODES.PLATFORM_CONTENT_MODERATION_BLOCKED;
  readonly errorType = PLATFORM_ERROR_CODES.PLATFORM_CONTENT_MODERATION_BLOCKED;
  readonly recordId?: string;

  constructor(body: ContentModerationBlockedBody) {
    super(body.message ?? '');
    this.name = 'ContentModerationBlockedError';
    this.category = body.category;
    this.recordId = body.recordId;
  }
}

export const isContentModerationBlockedError = (
  error: unknown,
): error is ContentModerationBlockedError => {
  if (error instanceof ContentModerationBlockedError) return true;
  if (!error || typeof error !== 'object') return false;
  return (
    (error as { errorType?: unknown }).errorType ===
    PLATFORM_ERROR_CODES.PLATFORM_CONTENT_MODERATION_BLOCKED
  );
};

export const toContentModerationBlockedBody = (
  error: unknown,
): ContentModerationBlockedBody | undefined => {
  if (!isContentModerationBlockedError(error)) return undefined;
  const record = error as ContentModerationBlockedError;
  return {
    ...(record.message ? { message: record.message } : {}),
    ...(record.category ? { category: record.category } : {}),
    ...(record.recordId ? { recordId: record.recordId } : {}),
  };
};
