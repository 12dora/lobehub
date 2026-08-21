import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';

import debug from 'debug';

import { DEFAULT_DOCKER_SOCKET, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS } from './constants';

const log = debug('lobe-server:sandbox:local:docker');

const STREAM_STDOUT = 1;
const STREAM_STDERR = 2;
const HEADER_SIZE = 8;

export class DockerEngineError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DockerEngineError';
    this.status = status;
  }
}

export const isDockerNotFound = (error: unknown) =>
  error instanceof DockerEngineError && error.status === 404;

export const isDockerUnreachable = (error: unknown) => {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'ENOENT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH' ||
    /unreachable|ECONNREFUSED|ENOENT|socket hang up/i.test(error.message)
  );
};

export const wrapDockerUnreachable = (error: unknown): DockerEngineError => {
  if (error instanceof DockerEngineError) return error;
  const cause = error as NodeJS.ErrnoException;
  const detail = cause.code ? `${cause.code}: ${cause.message}` : cause.message || String(error);
  const wrapped = new DockerEngineError(`Docker daemon is unreachable: ${detail}`);
  wrapped.cause = error;
  return wrapped;
};

export interface DockerEngineClientOptions {
  host?: string;
  socketPath?: string;
}

export interface DockerEndpointSocket {
  kind: 'socket';
  socketPath: string;
}

export interface DockerEndpointTcp {
  hostname: string;
  kind: 'tcp';
  port: number;
}

export type DockerEndpoint = DockerEndpointSocket | DockerEndpointTcp;

export interface DockerContainerCreateBody {
  Cmd?: string[];
  Env?: string[];
  HostConfig?: Record<string, unknown>;
  Image: string;
  Labels?: Record<string, string>;
  User?: string;
  Volumes?: Record<string, Record<string, never>>;
  WorkingDir?: string;
}

export interface DockerExecCreateBody {
  AttachStderr?: boolean;
  AttachStdin?: boolean;
  AttachStdout?: boolean;
  Cmd: string[];
  Privileged?: boolean;
  Tty?: boolean;
  User?: string;
  WorkingDir?: string;
}

export interface DockerExecStartResult {
  stderr: Buffer;
  stdout: Buffer;
  timedOut: boolean;
  truncated: boolean;
}

export interface DockerExecInspect {
  ExitCode: number | null;
  Pid?: number;
  Running: boolean;
}

export interface DockerContainerInspect {
  HostConfig?: { NetworkMode?: string };
  Id: string;
  Name?: string;
  State: { Running?: boolean; Status?: string };
}

export interface DockerContainerSummary {
  Id: string;
  Labels?: Record<string, string>;
  Names?: string[];
  State?: string;
}

export interface DockerImageInspect {
  Id: string;
}

export const parseDockerEndpoint = (options: DockerEngineClientOptions = {}): DockerEndpoint => {
  const { host, socketPath } = options;

  if (host) {
    const trimmed = host.trim();
    if (trimmed.startsWith('unix://')) {
      return {
        kind: 'socket',
        socketPath: trimmed.slice('unix://'.length) || DEFAULT_DOCKER_SOCKET,
      };
    }
    if (trimmed.startsWith('/') && !trimmed.includes('://')) {
      return { kind: 'socket', socketPath: trimmed };
    }
    if (
      trimmed.startsWith('tcp://') ||
      trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      /:\d+$/.test(trimmed)
    ) {
      const url = trimmed.includes('://') ? new URL(trimmed) : new URL(`tcp://${trimmed}`);
      return {
        hostname: url.hostname || '127.0.0.1',
        kind: 'tcp',
        port: url.port ? Number(url.port) : 2375,
      };
    }
  }

  if (socketPath) {
    if (socketPath.startsWith('unix://')) {
      return { kind: 'socket', socketPath: socketPath.slice('unix://'.length) };
    }
    return { kind: 'socket', socketPath };
  }

  return { kind: 'socket', socketPath: DEFAULT_DOCKER_SOCKET };
};

const splitImageRef = (image: string): { fromImage: string; tag: string } => {
  const at = image.lastIndexOf('@');
  if (at !== -1) return { fromImage: image, tag: '' };

  const lastColon = image.lastIndexOf(':');
  const lastSlash = image.lastIndexOf('/');
  if (lastColon > lastSlash && lastColon !== -1) {
    return { fromImage: image.slice(0, lastColon), tag: image.slice(lastColon + 1) };
  }

  return { fromImage: image, tag: 'latest' };
};

const jsonQuery = (params: Record<string, string | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

export class DockerEngineClient {
  readonly endpoint: DockerEndpoint;

  constructor(options: DockerEngineClientOptions = {}) {
    this.endpoint = parseDockerEndpoint(options);
  }

  endpointKey() {
    return this.endpoint.kind === 'socket'
      ? `unix://${this.endpoint.socketPath}`
      : `tcp://${this.endpoint.hostname}:${this.endpoint.port}`;
  }

  async ping(): Promise<void> {
    const { status, body } = await this.request('GET', '/_ping');
    if (status !== 200) {
      throw new DockerEngineError(
        body.toString('utf8') || `Docker ping failed with HTTP ${status}`,
        status,
      );
    }
  }

  async imageInspect(name: string): Promise<DockerImageInspect> {
    return this.requestJson<DockerImageInspect>('GET', `/images/${encodeURIComponent(name)}/json`);
  }

  async imagePull(name: string): Promise<void> {
    const { fromImage, tag } = splitImageRef(name);
    const path = `/images/create${jsonQuery({ fromImage, tag: tag || undefined })}`;
    const { status, stream } = await this.request('POST', path, { stream: true });

    if (!stream) {
      throw new DockerEngineError(`Docker image pull returned no stream (HTTP ${status})`, status);
    }

    if (status !== 200) {
      const body = await readAll(stream);
      throw new DockerEngineError(parseDockerError(body, status), status);
    }

    await drainPullStream(stream);
  }

  async containerCreate(name: string, body: DockerContainerCreateBody): Promise<{ Id: string }> {
    return this.requestJson<{ Id: string }>('POST', `/containers/create${jsonQuery({ name })}`, {
      json: body,
    });
  }

  async containerStart(id: string): Promise<void> {
    await this.requestEmpty('POST', `/containers/${encodeURIComponent(id)}/start`);
  }

  async containerStop(id: string, timeoutSec = 10): Promise<void> {
    await this.requestEmpty(
      'POST',
      `/containers/${encodeURIComponent(id)}/stop${jsonQuery({ t: String(timeoutSec) })}`,
    );
  }

  async containerKill(id: string, signal = 'KILL'): Promise<void> {
    await this.requestEmpty(
      'POST',
      `/containers/${encodeURIComponent(id)}/kill${jsonQuery({ signal })}`,
    );
  }

  async containerRemove(
    id: string,
    options: { force?: boolean; volumes?: boolean } = {},
  ): Promise<void> {
    await this.requestEmpty(
      'DELETE',
      `/containers/${encodeURIComponent(id)}${jsonQuery({
        force: options.force === false ? undefined : '1',
        v: options.volumes ? '1' : undefined,
      })}`,
    );
  }

  async containerInspect(id: string): Promise<DockerContainerInspect> {
    return this.requestJson<DockerContainerInspect>(
      'GET',
      `/containers/${encodeURIComponent(id)}/json`,
    );
  }

  async containerList(
    options: { all?: boolean; filters?: Record<string, string[]> } = {},
  ): Promise<DockerContainerSummary[]> {
    return this.requestJson<DockerContainerSummary[]>(
      'GET',
      `/containers/json${jsonQuery({
        all: options.all ? '1' : '0',
        filters: options.filters ? JSON.stringify(options.filters) : undefined,
      })}`,
    );
  }

  async volumeCreate(name: string, labels?: Record<string, string>): Promise<void> {
    await this.requestJson('POST', '/volumes/create', {
      json: { Labels: labels, Name: name },
    });
  }

  async volumeRemove(name: string, force = true): Promise<void> {
    await this.requestEmpty(
      'DELETE',
      `/volumes/${encodeURIComponent(name)}${jsonQuery({ force: force ? '1' : undefined })}`,
    );
  }

  async execCreate(containerId: string, body: DockerExecCreateBody): Promise<{ Id: string }> {
    return this.requestJson<{ Id: string }>(
      'POST',
      `/containers/${encodeURIComponent(containerId)}/exec`,
      { json: { AttachStderr: true, AttachStdout: true, Tty: false, ...body } },
    );
  }

  async execInspect(id: string): Promise<DockerExecInspect> {
    return this.requestJson<DockerExecInspect>('GET', `/exec/${encodeURIComponent(id)}/json`);
  }

  /**
   * Start an exec instance, demux Docker multiplexed stdout/stderr frames, and
   * honour `timeoutMs` by destroying the stream then SIGKILL-ing the exec PID
   * inside the container (when `containerId` is provided).
   */
  async execStart(
    id: string,
    options: { containerId?: string; maxOutputBytes?: number; timeoutMs?: number } = {},
  ): Promise<DockerExecStartResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const result = await this.execStartStream(id, { maxOutputBytes, timeoutMs });

    if (result.timedOut && options.containerId) {
      await this.killExecProcess(options.containerId, id);
    }

    return result;
  }

  async putArchive(containerId: string, path: string, tar: Buffer): Promise<void> {
    await this.requestEmpty(
      'PUT',
      `/containers/${encodeURIComponent(containerId)}/archive${jsonQuery({ path, noOverwriteDirNonDir: '0' })}`,
      {
        body: tar,
        contentType: 'application/x-tar',
      },
    );
  }

  async getArchive(containerId: string, path: string): Promise<Buffer> {
    const { status, body } = await this.request(
      'GET',
      `/containers/${encodeURIComponent(containerId)}/archive${jsonQuery({ path })}`,
    );

    if (status !== 200) {
      throw new DockerEngineError(parseDockerError(body, status), status);
    }

    return body;
  }

  private async killExecProcess(containerId: string, execId: string): Promise<void> {
    try {
      const inspect = await this.execInspect(execId);
      const pid = inspect.Pid;
      if (!pid || !inspect.Running) return;

      const killer = await this.execCreate(containerId, {
        AttachStderr: true,
        AttachStdout: true,
        Cmd: ['kill', '-9', String(pid)],
        User: '0:0',
      });
      await this.execStartStream(killer.Id, { maxOutputBytes: 1024, timeoutMs: 5_000 });
    } catch (error) {
      log('failed to kill exec %s in container %s: %O', execId, containerId, error);
    }
  }

  private async execStartStream(
    id: string,
    options: { maxOutputBytes: number; timeoutMs: number },
  ): Promise<DockerExecStartResult> {
    const { status, stream, req } = await this.request(
      'POST',
      `/exec/${encodeURIComponent(id)}/start`,
      {
        json: { Detach: false, Tty: false },
        stream: true,
      },
    );

    if (!stream || !req) {
      throw new DockerEngineError(`Docker exec start returned no stream (HTTP ${status})`, status);
    }

    if (status !== 200 && status !== 101) {
      const body = await readAll(stream);
      throw new DockerEngineError(parseDockerError(body, status), status);
    }

    return demuxDockerStream(stream, req, options);
  }

  private async requestJson<T>(
    method: string,
    path: string,
    init: { json?: unknown } = {},
  ): Promise<T> {
    const { status, body } = await this.request(method, path, { json: init.json });
    if (status >= 300) {
      throw new DockerEngineError(parseDockerError(body, status), status);
    }
    if (body.length === 0) return {} as T;
    try {
      return JSON.parse(body.toString('utf8')) as T;
    } catch (error) {
      throw new DockerEngineError(
        `Failed to parse Docker JSON response: ${(error as Error).message}`,
        status,
      );
    }
  }

  private async requestEmpty(
    method: string,
    path: string,
    init: { body?: Buffer; contentType?: string; json?: unknown } = {},
  ): Promise<void> {
    const { status, body } = await this.request(method, path, init);
    if (status >= 300 && status !== 304) {
      throw new DockerEngineError(parseDockerError(body, status), status);
    }
  }

  private async request(
    method: string,
    path: string,
    init: { body?: Buffer; contentType?: string; json?: unknown; stream?: boolean } = {},
  ): Promise<{
    body: Buffer;
    headers: IncomingHttpHeaders;
    req?: ReturnType<typeof httpRequest>;
    status: number;
    stream?: IncomingMessage;
  }> {
    const jsonBody = init.json === undefined ? undefined : Buffer.from(JSON.stringify(init.json));
    const body = init.body ?? jsonBody;
    const headers: Record<string, string> = {
      Host:
        this.endpoint.kind === 'tcp'
          ? `${this.endpoint.hostname}:${this.endpoint.port}`
          : 'localhost',
    };

    if (body) {
      headers['Content-Length'] = String(body.length);
      headers['Content-Type'] =
        init.contentType ??
        (init.json === undefined ? 'application/octet-stream' : 'application/json');
    }

    const opts: RequestOptions = {
      headers,
      method,
      path,
    };

    if (this.endpoint.kind === 'socket') {
      opts.socketPath = this.endpoint.socketPath;
    } else {
      opts.hostname = this.endpoint.hostname;
      opts.port = this.endpoint.port;
    }

    try {
      return await new Promise((resolve, reject) => {
        const req = httpRequest(opts, (res) => {
          const status = res.statusCode ?? 0;
          if (init.stream) {
            resolve({ body: Buffer.alloc(0), headers: res.headers, req, status, stream: res });
            return;
          }

          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer | string) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          });
          res.on('end', () => {
            resolve({ body: Buffer.concat(chunks), headers: res.headers, req, status });
          });
          res.on('error', reject);
        });

        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      });
    } catch (error) {
      throw wrapDockerUnreachable(error);
    }
  }
}

const readAll = async (stream: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

const parseDockerError = (body: Buffer, status: number) => {
  const text = body.toString('utf8').trim();
  if (!text) return `Docker request failed with HTTP ${status}`;
  try {
    const json = JSON.parse(text) as { message?: string; error?: string };
    if (typeof json.message === 'string' && json.message) return json.message;
    if (typeof json.error === 'string' && json.error) return json.error;
  } catch {
    // fall through to raw text
  }
  return text;
};

const drainPullStream = async (stream: IncomingMessage) => {
  let buffer = '';

  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      throwIfPullError(line);
    }
  }

  if (buffer.trim()) throwIfPullError(buffer);
};

const throwIfPullError = (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const json = JSON.parse(trimmed) as { error?: string; errorDetail?: { message?: string } };
    const message = json.error || json.errorDetail?.message;
    if (message) throw new DockerEngineError(message);
  } catch (error) {
    if (error instanceof DockerEngineError) throw error;
  }
};

interface Destroyable {
  destroy: (error?: Error) => void;
}

const demuxDockerStream = (
  stream: IncomingMessage,
  req: Destroyable,
  options: { maxOutputBytes: number; timeoutMs: number },
): Promise<DockerExecStartResult> => {
  const { maxOutputBytes, timeoutMs } = options;

  return new Promise((resolve, reject) => {
    let leftover = Buffer.alloc(0);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stderr: Buffer.concat(stderrChunks),
        stdout: Buffer.concat(stdoutChunks),
        timedOut,
        truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      stream.destroy();
      finish();
    }, timeoutMs);

    const append = (target: 'stdout' | 'stderr', payload: Buffer) => {
      const size = target === 'stdout' ? stdoutSize : stderrSize;
      if (size >= maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = maxOutputBytes - size;
      const slice = payload.length > remaining ? payload.subarray(0, remaining) : payload;
      if (payload.length > remaining) truncated = true;
      if (target === 'stdout') {
        stdoutChunks.push(slice);
        stdoutSize += slice.length;
      } else {
        stderrChunks.push(slice);
        stderrSize += slice.length;
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      leftover = Buffer.concat([leftover, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);

      while (leftover.length >= HEADER_SIZE) {
        const streamType = leftover[0];
        const frameSize = leftover.readUInt32BE(4);

        // Non-multiplexed (TTY) streams have no 8-byte header. If the size
        // looks insane, treat the remainder as raw stdout.
        if (
          frameSize > 16 * 1024 * 1024 ||
          (streamType !== STREAM_STDOUT && streamType !== STREAM_STDERR && streamType !== 0)
        ) {
          append('stdout', leftover);
          leftover = Buffer.alloc(0);
          break;
        }

        if (leftover.length < HEADER_SIZE + frameSize) break;

        const payload = leftover.subarray(HEADER_SIZE, HEADER_SIZE + frameSize);
        leftover = leftover.subarray(HEADER_SIZE + frameSize);

        if (streamType === STREAM_STDERR) append('stderr', payload);
        else append('stdout', payload);
      }
    });

    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (error) => {
      if (timedOut) {
        finish();
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
};
