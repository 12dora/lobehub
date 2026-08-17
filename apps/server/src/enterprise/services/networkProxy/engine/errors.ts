import { TRPCError } from '@trpc/server';

import type { EnterpriseErrorCode } from '@/const/platform/errorCodes';
import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';

import { mapEnterpriseCodeToTrpc } from '../../../guards/enterpriseErrors';

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
