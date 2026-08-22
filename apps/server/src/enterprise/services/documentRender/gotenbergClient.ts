const DEFAULT_PROBE_TIMEOUT_MS = 5000;

const trimEndpoint = (endpoint: string): string => endpoint.replace(/\/+$/, '');

const withTimeout = (timeoutMs: number): { abort: () => void; signal: AbortSignal } => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    abort: () => clearTimeout(timer),
    signal: controller.signal,
  };
};

export const convertToPdf = async (
  endpoint: string,
  params: { bytes: Uint8Array; filename: string; timeoutMs: number },
): Promise<Uint8Array> => {
  const { abort, signal } = withTimeout(params.timeoutMs);
  try {
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
    return new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
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
