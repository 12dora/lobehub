/**
 * Bounded response-body reads and abortable sleeps for the ChatGPT Web client.
 */

import { callerAbortReason, ChatGPTWebError, isChatGPTWebError } from './errors';

/** 32 MiB — comfortably above any generated image, far below "OOM the server". */
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Stream a response body into memory with a hard ceiling.
 *
 * `arrayBuffer()` has no limit at all: an upstream (or a redirected blob host)
 * that answers with a huge or endlessly-chunked body would otherwise be able to
 * exhaust the process.
 */
export const readBoundedBody = async (
  response: Response,
  maxBytes: number,
  fail: (error: unknown) => Error = (error) => error as Error,
): Promise<Uint8Array> => {
  if (!response.body) {
    const buffer = await response.arrayBuffer().catch((error: unknown) => {
      throw fail(error);
    });
    if (buffer.byteLength > maxBytes)
      throw new ChatGPTWebError('upstream', `asset exceeds the ${maxBytes} byte limit`);
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new ChatGPTWebError('upstream', `asset exceeds the ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } catch (error) {
    throw isChatGPTWebError(error) ? error : fail(error);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

/** `setTimeout` that rejects with the caller's own abort reason. */
export const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const reason = callerAbortReason(signal);
    if (reason !== undefined) {
      reject(reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(callerAbortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
