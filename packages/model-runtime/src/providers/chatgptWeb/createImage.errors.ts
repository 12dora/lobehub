/**
 * Public-facing error shaping for ChatGPT Web image generation. Strips leaky
 * upstream strings and builds the timeout / provider failure payloads the async
 * image router matches on.
 */

import { AgentRuntimeErrorType } from '../../types/error';
import type { CreateImageErrorPayload } from '../../types/type';
import { AgentRuntimeError } from '../../utils/createError';
import { isChatGPTWebError } from './errors';

/**
 * Whole-call budget. The async image task is killed at 298s
 * (`ASYNC_TASK_TIMEOUT`) and the caller still has to download, probe and upload
 * the result afterwards, so we stop well before that.
 *
 * It is enforced by ONE `AbortController` armed at entry whose signal is
 * threaded through every phase — a per-phase timeout alone would let four
 * uploads plus a stream plus a poll add up to several minutes.
 */
export const IMAGE_OVERALL_BUDGET_MS = 200_000;

export const MIME_EXTENSIONS: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Upstream strings that must never reach an end user (E3 §6). */
const LEAKY_MARKERS = [
  'backend-api/',
  'status=',
  'body=',
  'chatgpt.com',
  // the reference client's own error class name; it stringifies path + body
  'upstreamhttperror',
];

const GENERIC_FAILURE = 'The image generation request failed. Please try again later.';

export const publicMessage = (message: string | undefined, fallback = GENERIC_FAILURE): string => {
  const text = (message ?? '').trim();
  if (!text) return fallback;
  const lowered = text.toLowerCase();
  return LEAKY_MARKERS.some((marker) => lowered.includes(marker)) ? fallback : text;
};

export const isCreateImageErrorPayload = (value: unknown): value is CreateImageErrorPayload =>
  typeof value === 'object' &&
  value !== null &&
  'errorType' in value &&
  'provider' in value &&
  !(value instanceof Error);

export const fail = (
  provider: string,
  errorType: CreateImageErrorPayload['errorType'],
  message: string,
): CreateImageErrorPayload =>
  AgentRuntimeError.createImage({ error: { message }, errorType, provider });

/**
 * Timeout-shaped failure payload.
 *
 * `apps/server/src/routers/async/imageError.ts` only reaches its `TaskTimeout`
 * branch through `error.message?.includes('timeout')` on the TOP-LEVEL payload,
 * and only after every `errorType` branch has missed. So the payload must
 * (a) carry an `errorType` none of those branches claims — `ProviderNetworkError`,
 * which is also what `errors.ts` maps a `timeout` kind to — and (b) spell the
 * literal word "timeout" in `message` (`"timed out"` would NOT match).
 */
export const timeoutFailure = (provider: string, phase: string): CreateImageErrorPayload =>
  ({
    error: {
      message: `ChatGPT Web did not finish the image ${phase} within the ${Math.round(
        IMAGE_OVERALL_BUDGET_MS / 1000,
      )}s timeout.`,
    },
    errorType: AgentRuntimeErrorType.ProviderNetworkError,
    message: `ChatGPT Web image ${phase} hit the request timeout.`,
    provider,
  }) as CreateImageErrorPayload;

/** Host only — a presigned reference URL carries its credential in the query. */
export const safeHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown-host';
  }
};

/** Error identity without its message: node-fetch bakes the full URL into it. */
export const errorLabel = (error: unknown): string => {
  if (isChatGPTWebError(error)) return `ChatGPTWebError(${error.kind})`;
  return error instanceof Error ? error.name : typeof error;
};
