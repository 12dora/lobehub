import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

/** Deploy-time codes that should surface as a single setup guidance empty state. */
const SETUP_GUIDANCE_CODES = new Set<string>([
  PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
  PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
]);

const SETUP_GUIDANCE_MESSAGE_MARKERS = [
  'PLATFORM_FEATURE_DISABLED',
  'PLATFORM_SECRET_REQUIRED',
  'PLATFORM_APP_URL_INVALID',
] as const;

const extractErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const parts: string[] = [];
  if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
    parts.push((error as { message: string }).message);
  }
  const data = (error as { data?: { errorData?: { message?: unknown } } }).data;
  if (typeof data?.errorData?.message === 'string') parts.push(data.errorData.message);
  const cause = (error as { cause?: { data?: { message?: unknown } } }).cause;
  if (typeof cause?.data?.message === 'string') parts.push(cause.data.message);
  return parts.join(' ');
};

/**
 * True when list/load failed because Database OIDC is disabled or deploy config is incomplete.
 * Does not treat PLATFORM_INVALID_INPUT (generic validation) as setup guidance.
 */
export const isIdentityProviderSetupGuidanceError = (error: unknown): boolean => {
  if (!error) return false;
  const mapped = mapEnterpriseError(error);
  if (mapped && SETUP_GUIDANCE_CODES.has(mapped.code)) return true;
  // Never promote generic invalid-input to the deploy guidance empty state.
  if (mapped?.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT) return false;
  const message = extractErrorMessage(error);
  return SETUP_GUIDANCE_MESSAGE_MARKERS.some((marker) => message.includes(marker));
};
