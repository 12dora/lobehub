import { TRPCError } from '@trpc/server';

import type { EnterpriseErrorCode } from '@/const/platform/errorCodes';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { NetworkProxyEngineIssueCode } from '@/const/platform/networkProxy';
import { isNetworkProxyEngineIssueCode } from '@/const/platform/networkProxy';

import { getEnterpriseErrorBody, mapEnterpriseCodeToTrpc } from '../../../guards/enterpriseErrors';

export class NetworkProxyEngineError extends Error {
  readonly code: EnterpriseErrorCode;

  constructor(code: EnterpriseErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'NetworkProxyEngineError';
    this.code = code;
  }
}

/** Throw a structured enterprise error (TRPC-shaped) with a network-proxy code. */
export const throwNetworkProxyError = (code: EnterpriseErrorCode, message?: string): never => {
  const body = { code, message: message ?? code };
  throw new TRPCError({
    cause: { data: body },
    code: mapEnterpriseCodeToTrpc(code),
    message: body.message,
  });
};

export const NETWORK_PROXY_ENGINE_ERROR_CODES = {
  ARTIFACT_MISMATCH: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH,
  ENGINE_ERROR: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ENGINE_ERROR,
  ENGINE_NOT_INSTALLED: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ENGINE_NOT_INSTALLED,
  SUBSCRIPTION_INVALID: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_SUBSCRIPTION_INVALID,
  UNSUPPORTED_PLATFORM: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNSUPPORTED_PLATFORM,
} as const;

const ENTERPRISE_CODE_TO_ISSUE: Partial<Record<EnterpriseErrorCode, NetworkProxyEngineIssueCode>> =
  {
    [PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ARTIFACT_MISMATCH]: 'artifact_mismatch',
    [PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_ENGINE_NOT_INSTALLED]: 'artifact_missing',
    [PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_GLOBAL_PROXY_ACTIVE]: 'global_proxy_active',
    [PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_UNSUPPORTED_PLATFORM]: 'unsupported_platform',
  };

const enterpriseCodeFromError = (error: unknown): EnterpriseErrorCode | null => {
  if (error instanceof NetworkProxyEngineError) return error.code;
  const body = getEnterpriseErrorBody(error);
  if (body?.code) return body.code;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code in PLATFORM_ERROR_CODES) {
      return code as EnterpriseErrorCode;
    }
  }
  if (error instanceof Error) {
    if (error.message in PLATFORM_ERROR_CODES) {
      return error.message as EnterpriseErrorCode;
    }
    for (const key of Object.values(PLATFORM_ERROR_CODES)) {
      if (error.message.includes(key)) return key;
    }
  }
  return null;
};

/** Map a thrown error to a persisted / local-outcome issue code (never a raw message). */
export const resolveEngineIssueCode = (error: unknown): NetworkProxyEngineIssueCode => {
  if (error instanceof Error && error.name === 'TimeoutError') return 'health_timeout';
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && isNetworkProxyEngineIssueCode(code)) return code;
  }
  const enterprise = enterpriseCodeFromError(error);
  if (enterprise) {
    const mapped = ENTERPRISE_CODE_TO_ISSUE[enterprise];
    if (mapped) return mapped;
  }
  if (error instanceof Error && /artifact download failed/i.test(error.message)) {
    return 'artifact_download_failed';
  }
  return 'unknown';
};
