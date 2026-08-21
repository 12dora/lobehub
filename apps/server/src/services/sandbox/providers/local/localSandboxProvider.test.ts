import { afterEach, describe, expect, it } from 'vitest';

import type { LocalSandboxProviderOptions } from '../../types';
import { FakeDockerEngine } from './__tests__/fakeDockerEngine';
import { LocalSandboxProvider } from './localSandboxProvider';
import { runWithLocalSandboxSession } from './sessionContext';
import { resetLocalSandboxSupervisors } from './supervisor';

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
  idleTtlSec: extra.idleTtlSec ?? 1800,
  image: extra.image ?? 'aihub-sandbox:latest',
  maxContainers: extra.maxContainers ?? 8,
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

  it('exports a single file by extracting getArchive and PUTting the upload URL', async () => {
    const fake = await start();
    const provider = new LocalSandboxProvider(engineOptions(fake.socketPath));
    await provider.callTool('writeFile', { content: 'exported', path: 'out.txt' });

    const uploaded: Buffer[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      uploaded.push(Buffer.from(String(init?.body ?? '')));
      expect(String(input)).toBe('https://uploads.example.com/put');
      expect(init?.method).toBe('PUT');
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
});
