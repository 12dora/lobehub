import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import createDebug from 'debug';

import { scrubJsonValue, scrubSecretString } from './scrub';

const timing = createDebug('lobe-cursor:timing');

const KILL_GRACE_MS = 3000;
const MAX_DIAGNOSTIC_CHARS = 8192;
const MAX_ERROR_MESSAGE_CHARS = 500;
/** Keep in sync with `packages/model-runtime/src/core/streams/cursor.ts`. */
const AUTH_FAILURE_RE =
  /not logged in|unauthori[sz]ed|unauthenticated|\b401\b|authentication|log in|expired token|token expired|invalid token|invalid_api_key/i;

type TransportErrorCode = 'aborted' | 'cli_exit' | 'timeout' | 'unauthorized';

export const trimErrorMessage = (text: string, token: string): string =>
  scrubSecretString(text, token).trim().slice(0, MAX_ERROR_MESSAGE_CHARS);

export const looksLikeAuthFailure = (text: string): boolean => AUTH_FAILURE_RE.test(text);

export const appendBounded = (store: { text: string }, chunk: string, maxChars: number): void => {
  if (store.text.length >= maxChars) return;
  store.text += chunk.slice(0, maxChars - store.text.length);
};

export const appendDiagnostic = (store: { text: string }, chunk: string): void => {
  appendBounded(store, chunk, MAX_DIAGNOSTIC_CHARS);
};

const resultErrorText = (parsed: Record<string, unknown>): string => {
  const parts: string[] = [];
  if (typeof parsed.message === 'string') parts.push(parsed.message);
  if (typeof parsed.result === 'string') parts.push(parsed.result);
  if (typeof parsed.text === 'string') parts.push(parsed.text);
  const nested = parsed.error;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    if (typeof record.message === 'string') parts.push(record.message);
  }
  return parts.join('\n');
};

const isErrorResult = (parsed: Record<string, unknown>): boolean =>
  parsed.is_error === true || parsed.subtype === 'error';

export const killChild = (child: ChildProcessWithoutNullStreams, graceMs = KILL_GRACE_MS): void => {
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone.
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }, graceMs);
  timer.unref?.();
};

const transportErrorEvent = (
  code: TransportErrorCode,
  message: string,
  exitCode?: number | null,
): string =>
  JSON.stringify({
    code,
    ...(exitCode === undefined || exitCode === null ? {} : { exitCode }),
    message,
    subtype: 'error',
    type: 'transport',
  });

export const relayCliStream = (params: {
  child: ChildProcessWithoutNullStreams;
  onFinally: () => void;
  signal?: AbortSignal;
  spawnedAt: number;
  timeoutMs: number;
  token: string;
}): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const diagnostics = { text: '' };
  let buffer = '';
  let sawResult = false;
  let closed = false;
  let finalized = false;
  let timedOut = false;
  let aborted = false;
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;

  const kill = () => {
    if (killTimer) return;
    try {
      params.child.kill('SIGTERM');
    } catch {
      // Already gone.
    }
    killTimer = setTimeout(() => {
      try {
        params.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, KILL_GRACE_MS);
    killTimer.unref?.();
  };

  let onAbort = (): void => undefined;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    params.signal?.removeEventListener('abort', onAbort);
    try {
      params.onFinally();
    } catch {
      // Scratch / gate cleanup must never throw into the stream.
    }
  };

  return new ReadableStream<Uint8Array>({
    cancel() {
      aborted = true;
      closed = true;
      kill();
      finalize();
    },
    start(controller) {
      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          closed = true;
        }
      };

      const finish = (exitCode: number | null) => {
        try {
          if (!closed) {
            if (timeoutTimer) clearTimeout(timeoutTimer);
            params.signal?.removeEventListener('abort', onAbort);
            if (!sawResult) {
              const diagnostic = trimErrorMessage(diagnostics.text, params.token);
              if (aborted) {
                send(transportErrorEvent('aborted', diagnostic || 'aborted', exitCode));
              } else if (timedOut) {
                send(transportErrorEvent('timeout', diagnostic || 'turn timed out', exitCode));
              } else if (looksLikeAuthFailure(diagnostics.text)) {
                send(transportErrorEvent('unauthorized', diagnostic || 'unauthorized', exitCode));
              } else {
                send(
                  transportErrorEvent(
                    'cli_exit',
                    diagnostic || 'CLI exited without a result',
                    exitCode,
                  ),
                );
              }
            }
            send('[DONE]');
            closed = true;
            try {
              controller.close();
            } catch {
              // Already closed / cancelled.
            }
          }
        } finally {
          if (!killTimer && (aborted || timedOut)) kill();
          finalize();
        }
      };

      let firstAssistantLogged = false;
      const handleLine = (line: string) => {
        if (!line || closed) return;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            appendDiagnostic(diagnostics, `${line}\n`);
            return;
          }
          const record = parsed as Record<string, unknown>;
          if (!firstAssistantLogged && record.type === 'assistant') {
            firstAssistantLogged = true;
            timing('spawn to first assistant delta durationMs=%d', Date.now() - params.spawnedAt);
          }
          if (record.type === 'result') {
            sawResult = true;
            if (isErrorResult(record) && looksLikeAuthFailure(resultErrorText(record))) {
              const diagnostic = trimErrorMessage(resultErrorText(record), params.token);
              send(transportErrorEvent('unauthorized', diagnostic || 'unauthorized'));
              return;
            }
          }
          send(JSON.stringify(scrubJsonValue(record, params.token)));
        } catch {
          appendDiagnostic(diagnostics, `${line}\n`);
        }
      };

      onAbort = () => {
        aborted = true;
        kill();
      };

      params.child.stdout.setEncoding('utf8');
      params.child.stderr.setEncoding('utf8');
      let firstStdoutLogged = false;
      params.child.stdout.on('data', (chunk: string) => {
        if (!firstStdoutLogged) {
          firstStdoutLogged = true;
          timing('spawn to first-stdout-line durationMs=%d', Date.now() - params.spawnedAt);
        }
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          let line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          handleLine(line);
          newline = buffer.indexOf('\n');
        }
      });
      params.child.stderr.on('data', (chunk: string) => {
        appendDiagnostic(diagnostics, chunk);
      });
      params.child.stdout.on('error', () => undefined);
      params.child.stderr.on('error', () => undefined);
      params.child.stdin.on('error', () => undefined);
      params.child.stdin.end();

      params.child.on('error', (error) => {
        appendDiagnostic(diagnostics, error.message);
        finish(1);
      });
      params.child.on('close', (code) => {
        if (buffer.trim()) handleLine(buffer.replace(/\r$/, ''));
        buffer = '';
        finish(code);
      });

      params.signal?.addEventListener('abort', onAbort, { once: true });
      if (params.signal?.aborted) onAbort();

      timeoutTimer = setTimeout(() => {
        timedOut = true;
        kill();
      }, params.timeoutMs);
      timeoutTimer.unref?.();
    },
  });
};
