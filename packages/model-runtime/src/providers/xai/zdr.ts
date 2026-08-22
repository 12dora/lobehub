import { isRecord } from '@lobechat/utils/object';
import { ModelProvider } from 'model-bank';

import type { ChatCompletionErrorPayload } from '../../types';
import { AgentRuntimeErrorType } from '../../types/error';

const isHttp4xx = (status: unknown): status is number =>
  typeof status === 'number' && status >= 400 && status < 500;

const ZDR_TOKEN = /ZDR|zero.data.retention/i;
const ZDR_FILE = /file/i;

export const collectErrorStrings = (value: unknown, into: string[], depth = 0): void => {
  if (depth > 8 || value == null) return;
  if (typeof value === 'string') {
    if (value) into.push(value);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.message === 'string' && value.message) into.push(value.message);
  collectErrorStrings(value.error, into, depth + 1);
  collectErrorStrings(value.body, into, depth + 1);
};

const readStatus = (value: unknown, depth = 0): number | undefined => {
  if (depth > 6 || !isRecord(value)) return undefined;
  if (isHttp4xx(value.status)) return value.status;
  if (isHttp4xx(value.statusCode)) return value.statusCode;
  return readStatus(value.error, depth + 1);
};

/**
 * True for a 4xx (or unstatused) error whose nested message/body mentions
 * zero-data-retention and files. `exactMessages` / `pattern` OR with the
 * default matcher so Grok's CLI-proxy wording stays covered.
 */
export const isXaiZdrFileUnsupportedError = (
  error: unknown,
  extras?: { exactMessages?: readonly string[]; pattern?: RegExp },
): boolean => {
  const texts: string[] = [];
  collectErrorStrings(error, texts);
  const matched = texts.some(
    (text) =>
      extras?.exactMessages?.includes(text) ||
      extras?.pattern?.test(text) ||
      (ZDR_TOKEN.test(text) && ZDR_FILE.test(text)),
  );
  if (!matched) return false;
  const status = readStatus(error);
  return status === undefined || isHttp4xx(status);
};

export const xaiZdrErrorBody = (
  error: unknown,
  fallbackMessage: string,
): Record<string, unknown> => {
  if (!isRecord(error)) return { message: fallbackMessage };
  const status = typeof error.status === 'number' ? error.status : undefined;
  const nested = isRecord(error.error) ? error.error : undefined;
  return {
    ...(nested ?? {
      message: typeof error.message === 'string' ? error.message : fallbackMessage,
    }),
    ...(status !== undefined ? { status } : {}),
  };
};

export const toXaiZdrBizError = (
  error: unknown,
  message: string,
  provider: string = ModelProvider.XAI,
): ChatCompletionErrorPayload => {
  const payload = isRecord(error) ? error : {};
  return {
    ...payload,
    error: xaiZdrErrorBody(error, message),
    errorType: AgentRuntimeErrorType.ProviderBizError,
    message,
    provider: (typeof payload.provider === 'string' && payload.provider) || provider,
  };
};
