import type { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';

/** Detect a tRPC client error carrying the given error code. */
export const isTrpcErrorCode = (error: unknown, code: TRPC_ERROR_CODE_KEY): boolean => {
  if (typeof error !== 'object' || error === null) return false;

  return (error as { data?: { code?: unknown } }).data?.code === code;
};
