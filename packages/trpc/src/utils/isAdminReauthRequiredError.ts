import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';

const ADMIN_REAUTH_REQUIRED = ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED;

const readStructuredEnterpriseCode = (error: object): string | null => {
  // tRPC client / formatted shape: data.errorData.code
  const data = (error as { data?: { errorData?: unknown } }).data;
  if (data?.errorData && typeof data.errorData === 'object' && data.errorData) {
    const code = (data.errorData as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }

  // Server TRPCError before/while formatting: cause.data.code
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'data' in cause) {
    const body = (cause as { data?: unknown }).data;
    if (body && typeof body === 'object' && 'code' in body) {
      const code = (body as { code?: unknown }).code;
      if (typeof code === 'string' && code.length > 0) return code;
    }
  }

  return null;
};

const readMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message ?? '');
  }
  return '';
};

/**
 * Detect admin step-up reauth challenges (`ADMIN_REAUTH_REQUIRED`).
 *
 * These are intentionally UNAUTHORIZED/401 but are not session expiry.
 * Prefer structured enterprise `code` from `errorData` / `cause.data`.
 * Message fallback matches existing enterprise client helpers for older shapes.
 */
export const isAdminReauthRequiredError = (error: unknown): boolean => {
  if (error && typeof error === 'object') {
    const structured = readStructuredEnterpriseCode(error);
    if (structured === ADMIN_REAUTH_REQUIRED) return true;
  }

  const message = readMessage(error);
  // Compatibility with existing enterprise `isAdminReauthRequiredError` helpers
  return message.includes(ADMIN_REAUTH_REQUIRED);
};

/**
 * Whether a lambda tRPC 401 should trigger LobeHub logout + login redirect.
 * Market auth and admin reauth step-up challenges must not clear the session.
 */
export const shouldLogoutOnLambda401 = (params: {
  error: unknown;
  isMarketApi: boolean;
  status: number;
}): boolean => {
  if (params.status !== 401) return false;
  if (params.isMarketApi) return false;
  if (isAdminReauthRequiredError(params.error)) return false;
  return true;
};
