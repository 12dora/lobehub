import { type EnterpriseErrorCode, isEnterpriseErrorCode } from '@/const/platform/errorCodes';

const readCode = (value: unknown): EnterpriseErrorCode | undefined => {
  if (!value || typeof value !== 'object') return;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && isEnterpriseErrorCode(code) ? code : undefined;
};

/**
 * Read the stable enterprise code from the transport shapes used by tRPC clients.
 * Presentation consumers intentionally depend on this core-safe utility instead
 * of importing the enterprise client layer.
 */
export const getStructuredPlatformErrorCode = (error: unknown): EnterpriseErrorCode | undefined => {
  if (!error || typeof error !== 'object') return;

  const data = (error as { data?: { errorData?: unknown } }).data;
  const fromData = readCode(data?.errorData);
  if (fromData) return fromData;

  const cause = (error as { cause?: { data?: unknown } }).cause;
  const fromCause = readCode(cause?.data);
  if (fromCause) return fromCause;

  const json = (error as { json?: { data?: { errorData?: unknown } } }).json;
  return readCode(json?.data?.errorData);
};
