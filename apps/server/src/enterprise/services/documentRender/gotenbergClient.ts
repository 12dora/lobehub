const DEFAULT_PROBE_TIMEOUT_MS = 5000;
export const MIN_CONVERTED_BYTES = 16 * 1024 * 1024;
export const MAX_CONVERTED_BYTES = 256 * 1024 * 1024;

const trimEndpoint = (endpoint: string): string => endpoint.replace(/\/+$/, '');

const withTimeout = (timeoutMs: number): { abort: () => void; signal: AbortSignal } => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    abort: () => clearTimeout(timer),
    signal: controller.signal,
  };
};

export const resolveMaxConvertedBytes = (inputBytes: number): number =>
  Math.min(MAX_CONVERTED_BYTES, Math.max(MIN_CONVERTED_BYTES, inputBytes * 4));

const abortError = (): Error => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

const readCappedBody = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> => {
  if (signal?.aborted) throw abortError();

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(
      `Gotenberg convert response exceeds maxConvertedBytes (${contentLength} > ${maxBytes})`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(
        `Gotenberg convert response exceeds maxConvertedBytes (${buf.byteLength} > ${maxBytes})`,
      );
    }
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        throw abortError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(
          `Gotenberg convert response exceeds maxConvertedBytes (${total} > ${maxBytes})`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

export const convertToPdf = async (
  endpoint: string,
  params: {
    bytes: Uint8Array;
    filename: string;
    maxConvertedBytes?: number;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<Uint8Array> => {
  const { abort, signal: timeoutSignal } = withTimeout(params.timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
  const maxConvertedBytes =
    params.maxConvertedBytes ?? resolveMaxConvertedBytes(params.bytes.byteLength);
  try {
    if (signal.aborted) throw abortError();

    const form = new FormData();
    form.append(
      'files',
      new Blob([Buffer.from(params.bytes)], { type: 'application/octet-stream' }),
      params.filename,
    );

    const response = await fetch(`${trimEndpoint(endpoint)}/forms/libreoffice/convert`, {
      body: form,
      method: 'POST',
      signal,
    });
    if (!response.ok) {
      throw new Error(`Gotenberg convert failed: HTTP ${response.status}`);
    }
    return await readCappedBody(response, maxConvertedBytes, signal);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (params.signal?.aborted) throw error;
      throw new Error(`Gotenberg convert timed out after ${params.timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    abort();
  }
};

export interface GotenbergProbeResult {
  error?: string;
  latencyMs: number;
  ok: boolean;
  version?: string;
}

const readVersion = async (endpoint: string, timeoutMs: number): Promise<string> => {
  const { abort, signal } = withTimeout(timeoutMs);
  try {
    const response = await fetch(`${trimEndpoint(endpoint)}/version`, { method: 'GET', signal });
    if (!response.ok) return 'unknown';
    const text = (await response.text()).trim();
    return text.length > 0 ? text : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    abort();
  }
};

export const probeGotenberg = async (
  endpoint: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<GotenbergProbeResult> => {
  const started = Date.now();
  const { abort, signal } = withTimeout(timeoutMs);
  try {
    const response = await fetch(`${trimEndpoint(endpoint)}/health`, { method: 'GET', signal });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { error: `HTTP ${response.status}`, latencyMs, ok: false };
    }
    const headerVersion = response.headers.get('Gotenberg-Version')?.trim();
    const version =
      headerVersion && headerVersion.length > 0
        ? headerVersion
        : await readVersion(endpoint, timeoutMs);
    return { latencyMs, ok: true, version };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message =
      error instanceof Error && error.name === 'AbortError'
        ? `timeout after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { error: message, latencyMs, ok: false };
  } finally {
    abort();
  }
};
