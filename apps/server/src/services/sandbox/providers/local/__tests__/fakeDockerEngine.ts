import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SANDBOX_WORKSPACE } from '../constants';
import { FILE_OPS_SCRIPT } from '../fileOps';
import { extractTar, packTar, type TarEntry } from '../tarArchive';

export interface FakeFsNode {
  content?: Buffer;
  kind: 'dir' | 'file' | 'symlink';
  target?: string;
}

export interface FakeVolume {
  driver: string;
  labels: Record<string, string>;
  name: string;
  options: Record<string, string>;
  quotaBytes?: number;
}

export interface FakeContainer {
  config: Record<string, unknown>;
  createdAt: number;
  fs: Map<string, FakeFsNode>;
  id: string;
  labels: Record<string, string>;
  name: string;
  quotaBytes?: number;
  running: boolean;
}

export interface FakeExec {
  cmd: string[];
  containerId: string;
  exitCode?: number;
  hanging?: boolean;
  id: string;
  pid: number;
  running: boolean;
  started?: boolean;
  user?: string;
  workingDir?: string;
}

const muxFrame = (streamType: 1 | 2, data: Buffer | string) => {
  const payload = typeof data === 'string' ? Buffer.from(data) : data;
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const json = (res: ServerResponse, status: number, body: unknown) => {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Length': String(payload.length),
    'Content-Type': 'application/json',
  });
  res.end(payload);
};

const empty = (res: ServerResponse, status = 204) => {
  res.writeHead(status);
  res.end();
};

const parseUrl = (req: IncomingMessage) => {
  const raw = req.url ?? '/';
  const stripped = raw.replace(/^\/v1\.\d+/, '') || '/';
  const [pathname, search = ''] = stripped.split('?');
  return { pathname, query: new URLSearchParams(search) };
};

export class FakeDockerEngine {
  readonly containers = new Map<string, FakeContainer>();
  readonly execs = new Map<string, FakeExec>();
  readonly hangingResponses = new Map<string, ServerResponse>();
  readonly images = new Set<string>();
  readonly volumes = new Map<string, FakeVolume>();
  inspectHold?: Promise<void>;
  inspectStarted?: () => void;
  lastVolumeCreate?: Record<string, unknown>;
  missingInterpreters = new Set<string>();
  pullShouldFail = false;
  socketPath: string;

  private nextPid = 1000;
  private server?: Server;

  constructor(socketPath?: string) {
    this.socketPath =
      socketPath ?? path.join(tmpdir(), `aihub-dock-${randomUUID().slice(0, 8)}.sock`);
  }

  async listen(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error) => {
        if (!res.headersSent) {
          json(res, 500, { message: (error as Error).message });
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.socketPath, () => resolve());
    });

    return this.socketPath;
  }

  async close(): Promise<void> {
    for (const hanging of this.hangingResponses.values()) {
      hanging.end();
    }
    this.hangingResponses.clear();

    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    await unlink(this.socketPath).catch(() => undefined);
  }

  addImage(name: string) {
    this.images.add(name);
  }

  containerByNameOrId(id: string) {
    for (const container of this.containers.values()) {
      if (container.id === id || container.name === id || container.name === `/${id}`)
        return container;
    }
    return undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? 'GET';
    const { pathname, query } = parseUrl(req);

    if (method === 'GET' && pathname === '/_ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    const imageInspect = pathname.match(/^\/images\/(.+)\/json$/);
    if (method === 'GET' && imageInspect) {
      const name = decodeURIComponent(imageInspect[1]);
      if (
        !this.images.has(name) &&
        ![...this.images].some(
          (image) => image.startsWith(`${name}:`) || name.startsWith(`${image}:`) || image === name,
        )
      ) {
        json(res, 404, { message: `No such image: ${name}` });
        return;
      }
      json(res, 200, { Id: `sha256:${name}` });
      return;
    }

    if (method === 'POST' && pathname === '/images/create') {
      const fromImage = query.get('fromImage') || '';
      const tag = query.get('tag') || 'latest';
      const ref = tag ? `${fromImage}:${tag}` : fromImage;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (this.pullShouldFail) {
        res.end(
          `${JSON.stringify({ error: `failed to pull ${ref}`, errorDetail: { message: `failed to pull ${ref}` } })}\n`,
        );
        return;
      }
      this.images.add(ref);
      if (fromImage) this.images.add(fromImage);
      res.end(`${JSON.stringify({ status: `Pulled ${ref}` })}\n`);
      return;
    }

    if (method === 'GET' && pathname === '/containers/json') {
      const all = query.get('all') === '1';
      let filters: { label?: string[] };
      try {
        filters = JSON.parse(query.get('filters') || '{}') as { label?: string[] };
      } catch {
        filters = {};
      }
      const labelFilters = filters.label ?? [];
      const items = [...this.containers.values()]
        .filter((container) => all || container.running)
        .filter((container) =>
          labelFilters.every((label) => {
            const [key, value] = label.split('=');
            return value ? container.labels[key] === value : key in container.labels;
          }),
        )
        .map((container) => ({
          Created: Math.floor(container.createdAt / 1000),
          Id: container.id,
          Labels: container.labels,
          Names: [`/${container.name}`],
          State: container.running ? 'running' : 'exited',
        }));
      json(res, 200, items);
      return;
    }

    if (method === 'POST' && pathname === '/containers/create') {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as Record<string, unknown>;
      const name = query.get('name') || `ctr-${randomUUID().slice(0, 8)}`;
      if (this.containerByNameOrId(name)) {
        json(res, 409, { message: `Conflict. The container name "${name}" is already in use.` });
        return;
      }
      const id = `ctr-${randomUUID().slice(0, 12)}`;
      const labels = (body.Labels as Record<string, string> | undefined) ?? {};
      const fs = new Map<string, FakeFsNode>([[SANDBOX_WORKSPACE, { kind: 'dir' }]]);
      const quotaBytes = quotaFromVolume(this.volumes, labels['aihub.sandbox.volume']);
      this.containers.set(id, {
        config: body,
        createdAt: Date.now(),
        fs,
        id,
        labels,
        name,
        quotaBytes,
        running: false,
      });
      json(res, 201, { Id: id });
      return;
    }

    const containerPath = pathname.match(/^\/containers\/([^/]+)(?:\/(.*))?$/);
    if (containerPath) {
      const id = decodeURIComponent(containerPath[1]);
      const rest = containerPath[2] ?? '';
      const container = this.containerByNameOrId(id);
      if (!container) {
        json(res, 404, { message: `No such container: ${id}` });
        return;
      }

      if (method === 'GET' && rest === 'json') {
        this.inspectStarted?.();
        if (this.inspectHold) await this.inspectHold;
        json(res, 200, {
          Created: new Date(container.createdAt).toISOString(),
          HostConfig: (container.config.HostConfig as Record<string, unknown>) ?? {},
          Id: container.id,
          Name: `/${container.name}`,
          State: {
            Running: container.running,
            StartedAt: new Date(container.createdAt).toISOString(),
            Status: container.running ? 'running' : 'created',
          },
        });
        return;
      }

      if (method === 'POST' && rest === 'start') {
        container.running = true;
        empty(res, 204);
        return;
      }

      if (method === 'POST' && rest === 'stop') {
        container.running = false;
        empty(res, 204);
        return;
      }

      if (method === 'POST' && rest === 'kill') {
        container.running = false;
        empty(res, 204);
        return;
      }

      if (method === 'DELETE' && rest === '') {
        this.containers.delete(container.id);
        empty(res, 204);
        return;
      }

      if (method === 'POST' && rest === 'exec') {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          Cmd: string[];
          User?: string;
          WorkingDir?: string;
        };
        const execId = `exec-${randomUUID().slice(0, 12)}`;
        const hanging = isHangCommand(body.Cmd) && body.Cmd[0] !== 'timeout';
        this.execs.set(execId, {
          cmd: body.Cmd,
          containerId: container.id,
          hanging,
          id: execId,
          pid: this.nextPid++,
          running: false,
          user: body.User,
          workingDir: body.WorkingDir,
        });
        json(res, 201, { Id: execId });
        return;
      }

      if (method === 'PUT' && rest === 'archive') {
        const dest = query.get('path') || SANDBOX_WORKSPACE;
        const tar = await readBody(req);
        applyTarToFs(container.fs, dest, extractTar(tar));
        empty(res, 200);
        return;
      }

      if (method === 'GET' && rest === 'archive') {
        const path = query.get('path') || SANDBOX_WORKSPACE;
        const entries = collectTarFromFs(container.fs, path);
        if (entries.length === 0 && !container.fs.has(normalizeFsPath(path))) {
          json(res, 404, {
            message: `Could not find the file ${path} in container ${container.id}`,
          });
          return;
        }
        const archive = packTar(entries);
        res.writeHead(200, { 'Content-Type': 'application/x-tar' });
        res.end(archive);
        return;
      }
    }

    if (method === 'GET' && pathname === '/volumes') {
      json(res, 200, {
        Volumes: [...this.volumes.values()].map((volume) => ({
          Driver: volume.driver,
          Labels: volume.labels,
          Name: volume.name,
          Options: volume.options,
        })),
      });
      return;
    }

    if (method === 'POST' && pathname === '/volumes/create') {
      const body = JSON.parse((await readBody(req)).toString('utf8')) as {
        Driver?: string;
        DriverOpts?: Record<string, string>;
        Labels?: Record<string, string>;
        Name?: string;
      };
      this.lastVolumeCreate = body;
      if (body.Name) {
        this.volumes.set(body.Name, {
          driver: body.Driver || 'local',
          labels: body.Labels ?? {},
          name: body.Name,
          options: body.DriverOpts ?? {},
          quotaBytes: parseQuotaBytes(body.DriverOpts?.o),
        });
      }
      json(res, 201, { Name: body.Name });
      return;
    }

    const volumePath = pathname.match(/^\/volumes\/(.+)$/);
    if (method === 'DELETE' && volumePath) {
      this.volumes.delete(decodeURIComponent(volumePath[1]));
      empty(res, 204);
      return;
    }

    const execInspect = pathname.match(/^\/exec\/([^/]+)\/json$/);
    if (method === 'GET' && execInspect) {
      const exec = this.execs.get(execInspect[1]);
      if (!exec) {
        json(res, 404, { message: `No such exec instance: ${execInspect[1]}` });
        return;
      }
      json(res, 200, {
        ExitCode: exec.running ? null : (exec.exitCode ?? 0),
        Pid: exec.pid,
        Running: exec.running,
      });
      return;
    }

    const execStart = pathname.match(/^\/exec\/([^/]+)\/start$/);
    if (method === 'POST' && execStart) {
      await readBody(req);
      const exec = this.execs.get(execStart[1]);
      if (!exec) {
        json(res, 404, { message: `No such exec instance: ${execStart[1]}` });
        return;
      }
      const container = this.containers.get(exec.containerId);
      if (!container) {
        json(res, 404, { message: `No such container: ${exec.containerId}` });
        return;
      }

      exec.started = true;

      if (exec.hanging) {
        exec.running = true;
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
        res.flushHeaders();
        this.hangingResponses.set(exec.id, res);
        return;
      }

      const killed = tryKill(exec, container, this.execs, this.hangingResponses);
      if (killed) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
        res.end();
        return;
      }

      const output = runExec(exec, container, this.missingInterpreters);
      exec.running = false;
      res.writeHead(200, { 'Content-Type': 'application/vnd.docker.raw-stream' });
      const frames: Buffer[] = [];
      if (output.stdout) frames.push(muxFrame(1, output.stdout));
      if (output.stderr) frames.push(muxFrame(2, output.stderr));
      res.end(frames.length ? Buffer.concat(frames) : Buffer.alloc(0));
      exec.exitCode = output.exitCode;
      return;
    }

    json(res, 404, { message: `unknown ${method} ${pathname}` });
  }
}

const isHangCommand = (cmd: string[]) => {
  const joined = cmd.join(' ');
  return joined.includes('HANG') || /\bsleep\s+(?:999|2147483647|infinity)\b/.test(joined);
};

const tryKill = (
  exec: FakeExec,
  _container: FakeContainer,
  execs: Map<string, FakeExec>,
  hanging: Map<string, ServerResponse>,
) => {
  const cmd = exec.cmd;
  if (cmd[0] !== 'kill') return false;
  const pid = Number(cmd.at(-1));
  if (!Number.isFinite(pid)) return true;

  for (const other of execs.values()) {
    if (other.pid !== pid) continue;
    other.running = false;
    other.hanging = false;
    other.exitCode = 137;
    const res = hanging.get(other.id);
    if (res) {
      res.end();
      hanging.delete(other.id);
    }
  }
  return true;
};

const unwrapTimeout = (cmd: string[]): string[] => {
  if (cmd[0] !== 'timeout') return cmd;
  const execIdx = cmd.indexOf('exec "$0" "$@"');
  if (execIdx !== -1) return cmd.slice(execIdx + 1);
  const shIdx = cmd.indexOf('sh');
  if (shIdx !== -1 && (cmd[shIdx + 1] === '-c' || cmd[shIdx + 1] === '-lc')) {
    return cmd.slice(shIdx);
  }
  return cmd.slice(4);
};

const runExec = (
  exec: FakeExec,
  container: FakeContainer,
  missingInterpreters: Set<string>,
): { exitCode: number; stderr: string; stdout: string } => {
  if (exec.cmd[0] === 'timeout') {
    const inner = unwrapTimeout(exec.cmd);
    if (isHangCommand(inner)) {
      exec.exitCode = 124;
      return { exitCode: 124, stderr: 'timeout: sending signal KILL\n', stdout: '' };
    }
    return runExec({ ...exec, cmd: inner }, container, missingInterpreters);
  }

  const [bin, flag, ...rest] = exec.cmd;

  if (bin === 'chown') return { exitCode: 0, stderr: '', stdout: '' };

  if (bin === 'sh' && (flag === '-c' || flag === '-lc')) {
    const script = rest.join(' ');
    if (script === '__demux__') {
      return { exitCode: 0, stderr: 'err-data', stdout: 'out-data' };
    }
    return runShell(script, container, missingInterpreters);
  }

  if (bin === 'python3' && flag === '-c') {
    const script = rest.join(' ');
    if (script.includes('LOBE_SANDBOX_FILE_OPS') || script.includes(FILE_OPS_SCRIPT.slice(0, 40))) {
      return runFileOp(script, container);
    }
    return { exitCode: 0, stderr: '', stdout: 'ok\n' };
  }

  if (bin === 'python3' || bin === 'node' || bin === 'tsx' || bin === 'sh') {
    if (missingInterpreters.has(bin)) {
      return { exitCode: 127, stderr: `${bin}: not found\n`, stdout: '' };
    }
    return { exitCode: 0, stderr: '', stdout: 'executed\n' };
  }

  if (joined.includes('command -v')) {
    return runShell(joined, container, missingInterpreters);
  }

  return { exitCode: 0, stderr: '', stdout: '' };
};

const runShell = (
  script: string,
  container: FakeContainer,
  missingInterpreters: Set<string>,
): { exitCode: number; stderr: string; stdout: string } => {
  if (script.includes('command -v')) {
    const after = script.split('command -v')[1] ?? '';
    const bin = after.replaceAll(/['"]/g, '').trim().split(/\s/)[0] ?? '';
    if (!bin) return { exitCode: 1, stderr: '', stdout: '' };
    if (missingInterpreters.has(bin)) return { exitCode: 1, stderr: '', stdout: '' };
    return { exitCode: 0, stderr: '', stdout: `/usr/bin/${bin}\n` };
  }

  if (script.startsWith('echo') && !script.includes(';') && !script.includes('&&')) {
    const tokens = script.split(/\s+/);
    const skipN = tokens[1] === '-n' ? 2 : 1;
    const text = tokens
      .slice(skipN)
      .join(' ')
      .replaceAll(/^['"]|['"]$/g, '');
    return { exitCode: 0, stderr: '', stdout: tokens[1] === '-n' ? text : `${text}\n` };
  }

  if (script.startsWith('(') && script.includes('echo $!')) {
    return { exitCode: 0, stderr: '', stdout: '' };
  }

  if (script.includes('HANG') || /\bsleep\s+(?:999|2147483647)/.test(script)) {
    return { exitCode: 0, stderr: '', stdout: '' };
  }

  if (script.startsWith('printf')) {
    return { exitCode: 0, stderr: '', stdout: '' };
  }

  void container;
  return { exitCode: 0, stderr: '', stdout: 'ok\n' };
};

const runFileOp = (
  script: string,
  container: FakeContainer,
): { exitCode: number; stderr: string; stdout: string } => {
  const match = script.match(/main\('([A-Za-z0-9+/=]+)'\)/);
  if (!match) return { exitCode: 1, stderr: 'missing file-op args', stdout: '' };

  const args = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as Record<
    string,
    unknown
  >;
  const op = String(args.op || '');

  try {
    const result = dispatchFileOp(op, args, container);
    return { exitCode: 0, stderr: '', stdout: `${JSON.stringify(result)}\n` };
  } catch (error) {
    return {
      exitCode: 0,
      stderr: '',
      stdout: `${JSON.stringify({ error: (error as Error).message, success: false })}\n`,
    };
  }
};

const normalizeFsPath = (input: string) => {
  const raw = input.startsWith('/') ? input : `${SANDBOX_WORKSPACE}/${input}`;
  const parts: string[] = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
};

const realpathFs = (fs: Map<string, FakeFsNode>, input: string) => {
  const normalized = normalizeFsPath(input);
  const parts = normalized.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = `${current}/${part}`;
    const node = fs.get(current);
    if (node?.kind === 'symlink') {
      const target = node.target?.startsWith('/')
        ? node.target
        : normalizeFsPath(`${current}/../${node.target}`);
      current = realpathFs(fs, target ?? current);
    }
  }
  return current || '/';
};

const assertJailed = (path: string) => {
  if (path !== SANDBOX_WORKSPACE && !path.startsWith(`${SANDBOX_WORKSPACE}/`)) {
    throw new Error(`path escapes sandbox workspace: ${path}`);
  }
};

const jailed = (fs: Map<string, FakeFsNode>, input: string | undefined) => {
  const resolved = realpathFs(fs, input || SANDBOX_WORKSPACE);
  assertJailed(resolved);
  return resolved;
};

const ensureDir = (fs: Map<string, FakeFsNode>, path: string) => {
  const parts = path.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    if (!fs.has(current)) fs.set(current, { kind: 'dir' });
  }
};

const dispatchFileOp = (op: string, args: Record<string, unknown>, container: FakeContainer) => {
  const fs = container.fs;

  if (op === 'list') {
    const directory = jailed(fs, String(args.directoryPath || '.'));
    const prefix = directory === '/' ? '/' : `${directory}/`;
    const files = [];
    for (const [path, node] of fs) {
      if (path === directory) continue;
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      files.push({
        isDirectory: node.kind === 'dir',
        mtime: 0,
        name: rest,
        path,
        size: node.content?.length ?? 0,
      });
    }
    return { files, totalCount: files.length };
  }

  if (op === 'read') {
    const path = jailed(fs, String(args.path || ''));
    const node = fs.get(path);
    if (node?.kind !== 'file') throw new Error(`ENOENT: ${path}`);
    const text = node.content?.toString('utf8') ?? '';
    const lines = text.split(/(?<=\n)/);
    let selected = lines;
    if (args.startLine !== undefined || args.endLine !== undefined) {
      const startIdx = Math.max((Number(args.startLine) || 1) - 1, 0);
      const endIdx = args.endLine === undefined ? lines.length : Number(args.endLine);
      selected = lines.slice(startIdx, endIdx);
    }
    const content = selected.join('');
    return {
      charCount: content.length,
      content,
      filename: path.split('/').pop(),
      totalCharCount: text.length,
      totalLineCount: lines.length,
    };
  }

  if (op === 'prepare_write') {
    const path = jailed(fs, String(args.path || ''));
    if (args.createDirectories)
      ensureDir(fs, path.split('/').slice(0, -1).join('/') || SANDBOX_WORKSPACE);
    fs.set(path, { content: Buffer.alloc(0), kind: 'file' });
    return { success: true };
  }

  if (op === 'append_chunk') {
    const path = jailed(fs, String(args.path || ''));
    const chunk = Buffer.from(String(args.chunk || ''), 'base64');
    const existing = fs.get(path);
    const prev =
      existing?.kind === 'file' ? (existing.content ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const next = Buffer.concat([prev, chunk]);
    if (container.quotaBytes && fsUsage(fs) - prev.length + next.length > container.quotaBytes) {
      throw new Error('ENOSPC: No space left on device');
    }
    fs.set(path, { content: next, kind: 'file' });
    return { bytesWritten: chunk.length, success: true };
  }

  if (op === 'stat') {
    const path = jailed(fs, String(args.path || ''));
    const node = fs.get(path);
    if (node?.kind !== 'file') throw new Error(`ENOENT: ${path}`);
    return { path, size: node.content?.length ?? 0 };
  }

  if (op === 'edit') {
    const path = jailed(fs, String(args.path || ''));
    const node = fs.get(path);
    if (node?.kind !== 'file') throw new Error(`ENOENT: ${path}`);
    const search = String(args.search || '');
    const replace = String(args.replace || '');
    const text = node.content?.toString('utf8') ?? '';
    const count = search ? text.split(search).length - 1 : 0;
    if (count === 0) return { error: 'search text not found', replacements: 0, success: false };
    const next = args.all ? text.replaceAll(search, replace) : text.replace(search, replace);
    fs.set(path, { content: Buffer.from(next), kind: 'file' });
    return {
      linesAdded: replace.split('\n').length - 1,
      linesDeleted: search.split('\n').length - 1,
      replacements: args.all ? count : 1,
      success: true,
    };
  }

  if (op === 'grep') {
    const directory = jailed(fs, String(args.directory || '.'));
    const pattern = new RegExp(String(args.pattern || ''));
    const filePattern = String(args.filePattern || '*');
    const recursive = args.recursive !== false;
    const matches = [];
    for (const [path, node] of fs) {
      if (node.kind !== 'file') continue;
      if (path !== directory && !path.startsWith(`${directory}/`)) continue;
      if (!recursive && path.slice(directory.length + 1).includes('/')) continue;
      const name = path.split('/').pop() ?? '';
      if (filePattern !== '*' && !name.includes(filePattern.replaceAll('*', ''))) {
        // very small glob: '*txt' style via includes after stripping *
        const regex = new RegExp(
          `^${filePattern.replaceAll('.', String.raw`\.`).replaceAll('*', '.*')}$`,
        );
        if (!regex.test(name)) continue;
      }
      const text = node.content?.toString('utf8') ?? '';
      for (const [index, line] of text.split('\n').entries()) {
        if (pattern.test(line)) matches.push({ line, lineNumber: index + 1, path });
      }
    }
    return { matches, totalMatches: matches.length };
  }

  if (op === 'glob') {
    const directory = jailed(fs, String(args.directory || '.'));
    const pattern = String(args.pattern || '*');
    const regex = new RegExp(
      `^${pattern
        .replaceAll('.', String.raw`\.`)
        .replaceAll('**', '::DBLA::')
        .replaceAll('*', '[^/]*')
        .replaceAll('::DBLA::', '.*')}$`,
    );
    const files = [];
    for (const [path, node] of fs) {
      if (node.kind !== 'file') continue;
      if (path !== directory && !path.startsWith(`${directory}/`)) continue;
      const rel = path.slice(directory.length + 1);
      if (regex.test(rel) || regex.test(path.split('/').pop() ?? '')) files.push(path);
    }
    return { files, totalCount: files.length };
  }

  if (op === 'search') {
    const directory = jailed(fs, String(args.directory || '.'));
    const keyword = String(args.keyword || args.keywords || '');
    const results = [];
    for (const [path, node] of fs) {
      if (node.kind !== 'file') continue;
      if (!path.startsWith(`${directory}/`) && path !== directory) continue;
      const name = path.split('/').pop() ?? '';
      if (keyword && !name.includes(keyword)) continue;
      results.push({ mtime: 0, name, path, size: node.content?.length ?? 0 });
    }
    return { results, totalCount: results.length };
  }

  if (op === 'move') {
    const results = [];
    for (const operation of (args.operations as Array<{ destination: string; source: string }>) ||
      []) {
      try {
        const source = jailed(fs, operation.source);
        const destination = jailed(fs, operation.destination);
        const node = fs.get(source);
        if (!node) throw new Error(`ENOENT: ${source}`);
        fs.set(destination, node);
        fs.delete(source);
        results.push({
          destination: operation.destination,
          source: operation.source,
          success: true,
        });
      } catch (error) {
        results.push({
          destination: operation.destination,
          error: (error as Error).message,
          source: operation.source,
          success: false,
        });
      }
    }
    return { results, successCount: results.filter((item) => item.success).length };
  }

  if (op === 'delete') {
    const path = jailed(fs, String(args.path || ''));
    fs.delete(path);
    return { path, success: true };
  }

  throw new Error(`unknown file op: ${op}`);
};

const parseQuotaBytes = (opts?: string) => {
  if (!opts) return undefined;
  const match = opts.match(/size=(\d+)m/i);
  if (!match) return undefined;
  return Number(match[1]) * 1024 * 1024;
};

const quotaFromVolume = (volumes: Map<string, FakeVolume>, name?: string) => {
  if (!name) return undefined;
  return volumes.get(name)?.quotaBytes;
};

const fsUsage = (fs: Map<string, FakeFsNode>) => {
  let total = 0;
  for (const node of fs.values()) {
    if (node.kind === 'file') total += node.content?.length ?? 0;
  }
  return total;
};

const applyTarToFs = (fs: Map<string, FakeFsNode>, dest: string, entries: TarEntry[]) => {
  const root = normalizeFsPath(dest);
  for (const entry of entries) {
    const path = normalizeFsPath(`${root}/${entry.name}`);
    if (entry.type === 'directory') {
      ensureDir(fs, path);
    } else if (entry.type === 'file') {
      ensureDir(fs, path.split('/').slice(0, -1).join('/') || '/');
      fs.set(path, { content: entry.content, kind: 'file' });
    } else if (entry.type === 'symlink') {
      fs.set(path, { kind: 'symlink', target: entry.linkname });
    }
  }
};

const collectTarFromFs = (fs: Map<string, FakeFsNode>, path: string): TarEntry[] => {
  const root = normalizeFsPath(path);
  const node = fs.get(root);
  const basename = root.split('/').pop() || 'data';

  if (node?.kind === 'file') {
    return [{ content: node.content ?? Buffer.alloc(0), name: basename, type: 'file' }];
  }

  const entries: TarEntry[] = [];
  for (const [filePath, fileNode] of fs) {
    if (filePath !== root && !filePath.startsWith(`${root}/`)) continue;
    const rel = filePath === root ? basename : `${basename}/${filePath.slice(root.length + 1)}`;
    if (fileNode.kind === 'file') {
      entries.push({ content: fileNode.content ?? Buffer.alloc(0), name: rel, type: 'file' });
    } else if (fileNode.kind === 'dir') {
      entries.push({ content: Buffer.alloc(0), name: rel, type: 'directory' });
    }
  }
  return entries;
};
