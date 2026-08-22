import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalSandboxProviderOptions } from '../../types';
import { SANDBOX_PUT_FILES_MAX_FILE_BYTES } from '../../types';
import { FakeDockerEngine } from './__tests__/fakeDockerEngine';
import { DockerEngineClient } from './dockerEngineClient';
import { LocalSandboxProvider } from './localSandboxProvider';
import { runWithLocalSandboxSession } from './sessionContext';
import { getLocalSandboxSupervisor, resetLocalSandboxSupervisors, sessionKey } from './supervisor';
import { extractTar } from './tarArchive';

const engineOptions = (
  socketPath: string,
  extra: Partial<LocalSandboxProviderOptions> & {
    reaperIntervalMs?: number;
    topicId?: string;
    userId?: string;
  } = {},
): LocalSandboxProviderOptions & {
  reaperIntervalMs?: number;
  topicId?: string;
  userId?: string;
} => ({
  diskMb: extra.diskMb,
  idleTtlSec: extra.idleTtlSec ?? 1800,
  image: extra.image ?? 'aihub-sandbox:latest',
  maxContainers: extra.maxContainers ?? 8,
  maxExportBytes: extra.maxExportBytes,
  maxOutputBytes: extra.maxOutputBytes ?? 1_048_576,
  memoryBytes: extra.memoryBytes ?? 1024 * 1024 * 1024,
  nanoCpus: extra.nanoCpus ?? 1_000_000_000,
  network: extra.network ?? 'bridge',
  pidsLimit: extra.pidsLimit ?? 256,
  pullOnDemand: extra.pullOnDemand ?? true,
  pullPolicy: extra.pullPolicy ?? 'if-missing',
  reaperIntervalMs: extra.reaperIntervalMs,
  socketPath,
  timeoutMs: extra.timeoutMs ?? 5_000,
  topicId: extra.topicId ?? 'topic-1',
  userId: extra.userId ?? 'user-1',
});

describe('LocalSandboxProvider', () => {
  const engines: FakeDockerEngine[] = [];

  afterEach(async () => {
    await resetLocalSandboxSupervisors();
    await Promise.all(engines.splice(0).map(async (engine) => engine.close()));
  });

  const start = async (opts?: { image?: boolean }) => {
    const fake = new FakeDockerEngine();
    if (opts?.image !== false) fake.addImage('aihub-sandbox:latest');
    await fake.listen();
    engines.push(fake);
    return fake;
  };

  it('rejects path escapes before talking to the container', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath));

    const escaped = await provider.callTool('readFile', { path: '/etc/passwd' });
    expect(escaped).toMatchObject({
      error: { message: expect.stringMatching(/escapes sandbox workspace/) },
      success: false,
    });

    const dotted = await provider.callTool('writeFile', {
      content: 'x',
      path: '/mnt/data/../../etc/shadow',
    });
    expect(dotted.success).toBe(false);
    expect(fake.containers.size).toBe(0);
  });

  it('maps relative writes onto /mnt/data and round-trips write → read → list → grep', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath));

    const written = await provider.callTool('writeFile', {
      content: 'hello sandbox\nneedle line\n',
      createDirectories: true,
      path: 'notes/hello.txt',
    });
    expect(written).toMatchObject({
      result: { bytesWritten: 'hello sandbox\nneedle line\n'.length, success: true },
      success: true,
    });

    const read = await provider.callTool('readFile', { path: '/mnt/data/notes/hello.txt' });
    expect(read).toMatchObject({
      result: {
        content: 'hello sandbox\nneedle line\n',
        filename: 'hello.txt',
      },
      success: true,
    });

    const listed = await provider.callTool('listFiles', { directoryPath: '/mnt/data/notes' });
    expect(listed).toMatchObject({
      result: {
        files: [expect.objectContaining({ isDirectory: false, name: 'hello.txt' })],
        totalCount: 1,
      },
      success: true,
    });

    const grepped = await provider.callTool('grepContent', {
      directory: '/mnt/data',
      pattern: 'needle',
    });
    expect(grepped).toMatchObject({
      result: {
        matches: [expect.objectContaining({ line: 'needle line', lineNumber: 2 })],
        totalMatches: 1,
      },
      success: true,
    });

    const created = [...fake.containers.values()][0];
    const hostConfig = created.config.HostConfig as Record<string, unknown>;
    expect(created.config.User).toBe('1000:1000');
    expect(hostConfig.CapDrop).toEqual(['ALL']);
    expect(hostConfig.SecurityOpt).toEqual(['no-new-privileges']);
    expect(hostConfig.ReadonlyRootfs).toBe(true);
    expect(hostConfig.NetworkMode).toBe('bridge');
    expect(hostConfig.Privileged).toBe(false);
    expect(hostConfig.PidsLimit).toBe(256);
    expect(hostConfig.NanoCpus).toBe(1_000_000_000);
    expect(hostConfig.Memory).toBe(1024 * 1024 * 1024);
    expect(hostConfig.Tmpfs).toMatchObject({ '/tmp': expect.stringContaining('noexec') });
    expect(hostConfig.Mounts).toEqual([
      expect.objectContaining({ Target: '/mnt/data', Type: 'volume' }),
    ]);
    expect(fake.lastVolumeCreate).toMatchObject({
      Driver: 'local',
      DriverOpts: {
        device: 'tmpfs',
        o: expect.stringMatching(/size=512m,uid=1000,gid=1000/),
        type: 'tmpfs',
      },
    });
  });

  it('wraps execs with coreutils timeout and caps tool timeouts at the configured maximum', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath, { timeoutMs: 1000 }));

    await provider.callTool('runCommand', { command: 'echo ok', timeout: 999_000 });

    const exec = [...fake.execs.values()].find((item) => item.cmd[0] === 'timeout');
    expect(exec?.cmd.slice(0, 4)).toEqual(['timeout', '-k', '5', '1']);
  });

  it('honours in-container timeout for hanging commands without host-PID kill', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath, { timeoutMs: 1000 }));

    const result = await provider.callTool('runCommand', { command: 'HANG' });
    expect(result).toMatchObject({
      result: { exitCode: 124, success: false },
      success: true,
    });
    expect([...fake.execs.values()].some((item) => item.cmd[0] === 'kill')).toBe(false);
  });

  it('runs shell commands inside /mnt/data', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath));

    const result = await provider.callTool('runCommand', { command: 'echo ok' });
    expect(result).toMatchObject({
      result: { exitCode: 0, stdout: 'ok\n', success: true },
      success: true,
    });
  });

  it('returns a readable error when the interpreter is missing', async () => {
    const fake = await start();
    fake.missingInterpreters.add('python3');
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath));

    const result = await provider.callTool('executeCode', {
      code: 'print(1)',
      language: 'python',
    });

    expect(result).toMatchObject({
      error: { message: 'interpreter python3 not available in sandbox image' },
      success: false,
    });
  });

  it('returns a daemon unreachable error when the socket is missing', async () => {
    const provider = new LocalSandboxProvider(engineOptions('/tmp/aihub-no-such-docker.sock'));

    const result = await provider.callTool('runCommand', { command: 'echo hi' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/Docker daemon is unreachable/);
  });

  it('reaps idle containers after the TTL', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { idleTtlSec: 1, reaperIntervalMs: 40 }),
    );

    await provider.callTool('runCommand', { command: 'echo ok' });
    expect(fake.containers.size).toBe(1);

    await new Promise((resolve) => {
      setTimeout(resolve, 1200);
    });

    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.size).toBe(0);
  });

  it('rejects new sessions when max concurrent containers is exceeded', async () => {
    const fake = await start();
    const first = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { maxContainers: 2, topicId: 't1' }),
    );
    const second = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { maxContainers: 2, topicId: 't2' }),
    );
    const third = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { maxContainers: 2, topicId: 't3' }),
    );

    await first.callTool('runCommand', { command: 'echo a' });
    await second.callTool('runCommand', { command: 'echo b' });
    const overflow = await third.callTool('runCommand', { command: 'echo c' });

    expect(overflow).toMatchObject({
      error: { message: expect.stringMatching(/capacity exceeded: 2 concurrent containers/) },
      success: false,
    });
    expect(fake.containers.size).toBe(2);
  });

  it('pulls a missing image when pullOnDemand is allowed', async () => {
    const fake = await start({ image: false });
    const provider = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { pullOnDemand: true, pullPolicy: 'if-missing' }),
    );

    const result = await provider.callTool('runCommand', { command: 'echo ok' });
    expect(result.success).toBe(true);
    expect(fake.images.has('aihub-sandbox:latest')).toBe(true);
  });

  it('returns a clear error when the image is missing and pull is disabled', async () => {
    const fake = await start({ image: false });
    const provider = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { pullOnDemand: false, pullPolicy: 'never' }),
    );

    const result = await provider.callTool('runCommand', { command: 'echo ok' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/not present on the Docker daemon/);
  });

  it('uses AsyncLocalStorage session context from the middleware helper', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider({
      ...engineOptions(fake.socketPath),
      topicId: undefined,
      userId: undefined,
    });

    const result = await runWithLocalSandboxSession(
      { topicId: 'als-topic', userId: 'als-user' },
      () => provider.callTool('runCommand', { command: 'echo ok' }),
    );

    expect(result.success).toBe(true);
    const created = [...fake.containers.values()][0];
    expect(created.labels['aihub.sandbox.userId']).toBe('als-user');
    expect(created.labels['aihub.sandbox.topicId']).toBe('als-topic');
  });

  it('rejects exports larger than maxExportBytes before transferring', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { maxExportBytes: 4 }),
    );
    await provider.callTool('writeFile', { content: 'too-big', path: 'out.txt' });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const result = await provider.exportFileToUploadUrl({
        filename: 'out.txt',
        path: '/mnt/data/out.txt',
        uploadUrl: 'https://uploads.example.com/put',
      });
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/MAX_EXPORT_BYTES/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('surfaces a disk quota error when a write exceeds the tmpfs volume', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath, { diskMb: 1 }));

    const result = await provider.callTool('writeFile', {
      content: 'x'.repeat(2 * 1024 * 1024),
      path: 'huge.txt',
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/ENOSPC|No space left|quota/i);
  });

  it('adopts labeled containers after a supervisor restart and still enforces maxContainers', async () => {
    const fake = await start();
    const first = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { maxContainers: 1, topicId: 't1' }),
    );
    await first.callTool('runCommand', { command: 'echo a' });
    expect(fake.containers.size).toBe(1);

    await resetLocalSandboxSupervisors();
    expect(fake.containers.size).toBe(1);

    const adopted = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { maxContainers: 1, topicId: 't1' }),
    );
    const other = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { maxContainers: 1, topicId: 't2' }),
    );
    await adopted.callTool('runCommand', { command: 'echo still' });
    const overflow = await other.callTool('runCommand', { command: 'echo b' });

    expect(overflow.success).toBe(false);
    expect(overflow.error?.message).toMatch(/capacity exceeded/);
    expect(fake.containers.size).toBe(1);
  });

  it('reaps stale adopted containers and orphan volumes on reconcile', async () => {
    const fake = await start();
    const first = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { idleTtlSec: 1, topicId: 'old' }),
    );
    await first.callTool('runCommand', { command: 'echo a' });
    const container = [...fake.containers.values()][0];
    container.createdAt = Date.now() - 60_000;

    await resetLocalSandboxSupervisors();

    const next = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { idleTtlSec: 1, topicId: 'fresh' }),
    );
    await next.callTool('runCommand', { command: 'echo b' });

    expect([...fake.containers.values()].some((item) => item.name.includes('old'))).toBe(false);
    expect(fake.containers.size).toBe(1);
  });

  it('does not reap a session while a delayed inspect is in flight', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(
      engineOptions(fake.socketPath, { idleTtlSec: 1, reaperIntervalMs: 60_000 }),
    );
    await provider.callTool('runCommand', { command: 'echo ok' });

    const supervisor = getLocalSandboxSupervisor(
      new DockerEngineClient({ socketPath: fake.socketPath }),
      {
        diskMb: 512,
        idleTtlSec: 1,
        image: 'aihub-sandbox:latest',
        maxContainers: 8,
        memoryBytes: 1024,
        nanoCpus: 1e9,
        network: 'bridge',
        pidsLimit: 256,
        pullOnDemand: true,
        pullPolicy: 'if-missing',
      },
    );
    const key = sessionKey({ topicId: 'topic-1', userId: 'user-1' });
    const record = supervisor.sessions.get(key);
    expect(record).toBeDefined();
    record!.lastUsedAt = Date.now() - 10_000;

    let releaseInspect!: () => void;
    fake.inspectHold = new Promise<void>((resolve) => {
      releaseInspect = resolve;
    });
    let inspectStarted = false;
    fake.inspectStarted = () => {
      inspectStarted = true;
    };

    const running = provider.callTool('runCommand', { command: 'echo again' });
    await vi.waitFor(() => expect(inspectStarted).toBe(true));
    const reaped = supervisor.reapIdle();
    releaseInspect();
    const [result, removed] = await Promise.all([running, reaped]);

    expect(result.success).toBe(true);
    expect(removed).not.toContain(key);
    expect(fake.containers.size).toBe(1);
  });

  it('exports a single file by extracting getArchive and PUTting the upload URL', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath));
    await provider.callTool('writeFile', { content: 'exported', path: 'out.txt' });

    const uploaded: Buffer[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://uploads.example.com/put');
      expect(init?.method).toBe('PUT');
      const headers = new Headers(init?.headers);
      expect(headers.get('Content-Length')).toBe('8');
      uploaded.push(await readFetchBody(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      const result = await provider.exportFileToUploadUrl({
        filename: 'out.txt',
        path: '/mnt/data/out.txt',
        uploadHeaders: { 'x-amz-acl': 'public-read' },
        uploadUrl: 'https://uploads.example.com/put',
      });
      expect(result).toMatchObject({ size: 8, success: true });
      expect(uploaded[0]?.toString('utf8')).toBe('exported');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('putFiles packs one tar and putArchives it onto the session container', async () => {
    const fake = await start();
    const putArchive = vi.spyOn(DockerEngineClient.prototype, 'putArchive');
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath));

    try {
      const result = await provider.putFiles([
        { bytes: new Uint8Array([1, 2, 3]), path: '/mnt/data/uploads/report-file-1.pdf' },
        { bytes: new Uint8Array(0), path: '/mnt/data/uploads/.synced-file-1' },
      ]);

      expect(result.written).toEqual([
        '/mnt/data/uploads/report-file-1.pdf',
        '/mnt/data/uploads/.synced-file-1',
      ]);
      expect(result.failed).toEqual([]);
      expect(putArchive).toHaveBeenCalledTimes(1);

      const [containerId, dest, tar] = putArchive.mock.calls[0]!;
      expect(containerId).toBe([...fake.containers.values()][0]?.id);
      expect(dest).toBe('/mnt/data');
      const entries = extractTar(tar as Buffer);
      expect(entries.map((entry) => `${entry.type}:${entry.name}`)).toEqual(
        expect.arrayContaining([
          'directory:uploads',
          'file:uploads/report-file-1.pdf',
          'file:uploads/.synced-file-1',
        ]),
      );
      expect(entries.find((entry) => entry.name === 'uploads/report-file-1.pdf')?.content).toEqual(
        Buffer.from([1, 2, 3]),
      );

      const read = await provider.callTool('readFile', {
        path: '/mnt/data/uploads/report-file-1.pdf',
      });
      expect(read).toMatchObject({
        result: { content: '\u0001\u0002\u0003' },
        success: true,
      });
    } finally {
      putArchive.mockRestore();
    }
  });

  it('putFiles skips an oversize file without throwing and still writes the rest', async () => {
    const fake = await start();
    const putArchive = vi.spyOn(DockerEngineClient.prototype, 'putArchive');
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath));
    const huge = { byteLength: SANDBOX_PUT_FILES_MAX_FILE_BYTES + 1 } as Uint8Array;

    try {
      const result = await provider.putFiles([
        { bytes: new Uint8Array([9]), path: '/mnt/data/uploads/ok.txt' },
        { bytes: huge, path: '/mnt/data/uploads/huge.bin' },
      ]);

      expect(result.written).toEqual(['/mnt/data/uploads/ok.txt']);
      expect(result.failed).toEqual([
        { path: '/mnt/data/uploads/huge.bin', reason: 'file exceeds 64 MiB' },
      ]);
      expect(putArchive).toHaveBeenCalledTimes(1);
      const tar = putArchive.mock.calls[0]![2] as Buffer;
      const names = extractTar(tar)
        .filter((entry) => entry.type === 'file')
        .map((entry) => entry.name);
      expect(names).toEqual(['uploads/ok.txt']);
    } finally {
      putArchive.mockRestore();
    }
  });
});

const readFetchBody = async (body: BodyInit | null | undefined): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  if (Symbol.asyncIterator in new Object(body)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(body));
};
