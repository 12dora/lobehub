/* eslint-disable no-console */

import { isRecord } from '@lobechat/utils/object';

// no need to introduce a package to get the current time as this module is just a debug utility
const getTime = () => {
  const date = new Date();
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}.${date.getMilliseconds()}`;
};

const SCOPED_SIGNATURE_PREFIX = 'lobe-scoped-state-v1:';

const redactString = (value: string) => `[redacted:${value.length}]`;

const redactSummaryValue = (value: unknown): unknown => {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactSummaryValue);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'text' && typeof child === 'string' ? redactString(child) : redactSummaryValue(child),
    ]),
  );
};

export const redactReasoningPayload = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return value.startsWith(SCOPED_SIGNATURE_PREFIX) ? redactString(value) : value;
  }
  if (Array.isArray(value)) return value.map(redactReasoningPayload);
  if (!isRecord(value)) return value;

  const isReasoningSummaryEvent =
    typeof value.type === 'string' &&
    (value.type === 'summary_text' || value.type.startsWith('response.reasoning_summary'));

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === 'encrypted_content' && typeof child === 'string') {
        return [key, redactString(child)];
      }
      if (key === 'summary') return [key, redactSummaryValue(child)];
      if (
        isReasoningSummaryEvent &&
        (key === 'delta' || key === 'text') &&
        typeof child === 'string'
      ) {
        return [key, redactString(child)];
      }

      return [key, redactReasoningPayload(child)];
    }),
  );
};

export const serializeDebugPayload = (value: unknown): string =>
  JSON.stringify(redactReasoningPayload(value));

const redactDebugText = (value: string): string => {
  try {
    return serializeDebugPayload(JSON.parse(value));
  } catch {
    return value
      .split('\n')
      .map((line) => {
        if (!line.startsWith('data:')) return line;

        const dataValue = line.slice('data:'.length).trimStart();
        const dataPrefix = line.slice(0, line.length - dataValue.length);

        try {
          return `${dataPrefix}${serializeDebugPayload(JSON.parse(dataValue))}`;
        } catch {
          return line.replaceAll(/lobe-scoped-state-v1:[^\s"\\]+/g, (signature) =>
            redactString(signature),
          );
        }
      })
      .join('\n');
  }
};

export const debugStream = async (stream: ReadableStream) => {
  let finished = false;
  let chunk = 0;
  let chunkValue: any;
  let pendingText = '';
  const decoder = new TextDecoder();

  const reader = stream.getReader();

  console.log(`[stream start] ${getTime()}`);

  const logChunk = (value: string) => {
    console.log(`[chunk ${chunk}] ${getTime()}`);
    console.log(value);
    console.log('');
    chunk++;
  };

  while (!finished) {
    try {
      const { value, done } = await reader.read();

      if (done) {
        if (pendingText) {
          logChunk(redactDebugText(pendingText));
          pendingText = '';
        }
        console.log(`[stream finished] total chunks: ${chunk}\n`);
        finished = true;
        break;
      }

      if (typeof value === 'string' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        pendingText +=
          typeof value === 'string'
            ? value
            : decoder.decode(value as AllowSharedBufferSource, { stream: true });
        // A Responses SSE JSON line can be split at any byte boundary. Buffer
        // incomplete lines so no partial encrypted value is ever logged raw.
        const lastLineBreak = pendingText.lastIndexOf('\n');
        chunkValue = `[buffered:${pendingText.length}]`;
        if (lastLineBreak >= 0) {
          logChunk(redactDebugText(pendingText.slice(0, lastLineBreak + 1)));
          pendingText = pendingText.slice(lastLineBreak + 1);
        }
      } else {
        chunkValue = serializeDebugPayload(value);
        logChunk(chunkValue);
      }

      finished = done;
    } catch (e) {
      finished = true;
      console.error('[debugStream error]', e);
      console.error('[error chunk value:]', chunkValue);
    }
  }
};

export const debugResponse = (response: any) => {
  console.log(`\n[no stream response] ${getTime()}\n`);
  console.log(serializeDebugPayload(response) + '\n');
};
