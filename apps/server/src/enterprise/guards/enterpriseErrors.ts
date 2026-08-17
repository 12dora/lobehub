import { type TRPC_ERROR_CODE_KEY, TRPCError } from '@trpc/server';

import type { EnterpriseErrorCode } from '@/const/platform/errorCodes';
import type { EnterpriseErrorBody } from '@/types/platform/errors';

/**
 * Structured enterprise TRPCError.
 * `cause.data` is picked up by the lambda errorFormatter as `errorData`.
 */
export const throwEnterpriseError = (params: {
  code: EnterpriseErrorCode;
  details?: EnterpriseErrorBody['details'];
  httpCode?: TRPC_ERROR_CODE_KEY;
  message?: string;
}): never => {
  const body: EnterpriseErrorBody = {
    code: params.code,
    details: params.details,
    message: params.message ?? params.code,
  };

  throw new TRPCError({
    // cause shape matches packages/trpc errorFormatter (`cause.data` → errorData)
    cause: { data: body },
    code: params.httpCode ?? mapEnterpriseCodeToTrpc(params.code),
    message: body.message ?? params.code,
  });
};

export const mapEnterpriseCodeToTrpc = (code: EnterpriseErrorCode): TRPC_ERROR_CODE_KEY => {
  if (code === 'PLATFORM_PERMISSION_DENIED') {
    return 'FORBIDDEN';
  }
  if (code === 'ADMIN_ACCESS_DENIED' || code === 'ADMIN_FEATURE_DISABLED') {
    return 'FORBIDDEN';
  }
  if (code === 'ADMIN_RATE_LIMITED') return 'TOO_MANY_REQUESTS';
  if (code === 'ADMIN_REAUTH_REQUIRED') return 'UNAUTHORIZED';
  if (code === 'PLATFORM_REVISION_CONFLICT') return 'CONFLICT';
  if (code === 'PLATFORM_RESOURCE_IN_USE') return 'CONFLICT';
  if (code === 'PLATFORM_NETWORK_PROXY_GEODATA_MISSING') return 'PRECONDITION_FAILED';
  if (code === 'PLATFORM_NOT_FOUND') return 'NOT_FOUND';
  if (code === 'PLATFORM_AI_PROVIDER_DISABLED') return 'FORBIDDEN';
  if (code === 'PLATFORM_FEATURE_DISABLED' || code === 'PLATFORM_MODULE_DISABLED') {
    return 'FORBIDDEN';
  }
  if (code === 'PLATFORM_LAST_SUPER_ADMIN') return 'PRECONDITION_FAILED';
  if (code === 'PLATFORM_INVALID_INPUT' || code === 'ADMIN_REASON_REQUIRED') {
    return 'BAD_REQUEST';
  }
  if (
    code === 'MANAGED_SETTING_BY_ADMIN' ||
    code === 'MANAGED_RESOURCE_BY_PLATFORM' ||
    code === 'RESOURCE_MANAGED_BY_PLATFORM'
  ) {
    return 'FORBIDDEN';
  }
  if (
    code === 'MANAGED_SETTING_UNKNOWN_PATH' ||
    code === 'MANAGED_SETTING_SECRET_PATH' ||
    code === 'MANAGED_SETTING_INVALID_VALUE' ||
    code === 'MANAGED_SETTING_INAPPLICABLE_CLIENT' ||
    code === 'MANAGED_SETTING_NOT_POLICY_ELIGIBLE' ||
    code === 'MANAGED_POLICY_ENFORCED'
  ) {
    return 'BAD_REQUEST';
  }
  return 'BAD_REQUEST';
};

/** Extract EnterpriseErrorBody from a thrown TRPCError (tests / mappers). */
export const getEnterpriseErrorBody = (error: unknown): EnterpriseErrorBody | null => {
  if (!error || typeof error !== 'object') return null;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'data' in cause) {
    const data = (cause as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'code' in data) {
      return data as EnterpriseErrorBody;
    }
  }
  // Also accept already-formatted errorData
  const data = (error as { data?: { errorData?: unknown } }).data;
  if (
    data?.errorData &&
    typeof data.errorData === 'object' &&
    data.errorData &&
    'code' in data.errorData
  ) {
    return data.errorData as EnterpriseErrorBody;
  }
  return null;
};
