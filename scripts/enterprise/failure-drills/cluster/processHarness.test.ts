// @vitest-environment node
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { LoopbackFaultProxy } from './faultProxy';
import { ClusterProcessHarness, redactClusterDiagnostic } from './processHarness';

const bunExecutable = process.execPath.includes('bun') ? process.execPath : 'bun';
const cwd = process.cwd();
const children: ClusterProcessHarness[] = [];

const connectSocket = async (port: number): Promise<Socket> => {
  const socket = createConnection({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  return socket;
};

const harness = (
  source: string,
  options: { startTimeoutMs?: number; stopTimeoutMs?: number } = {},
) => {
  const child = new ClusterProcessHarness({
    args: ['-e', source],
    command: bunExecutable,
    cwd,
    env: { PATH: process.env.PATH },
    startTimeoutMs: options.startTimeoutMs,
    stopTimeoutMs: options.stopTimeoutMs,
  });
  children.push(child);
  return child;
};

afterEach(async () => {
  const results = await Promise.allSettled(children.splice(0).map((child) => child.terminate()));
  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Cluster harness test cleanup failed');
  }
});

describe('ClusterProcessHarness', () => {
  it('reports spawn failures without leaking the executable path', async () => {
    const child = new ClusterProcessHarness({
      args: [],
      command: 'o05b-command-that-does-not-exist',
      cwd,
      env: { PATH: process.env.PATH },
      startTimeoutMs: 100,
    });
    children.push(child);

    await expect(child.start()).rejects.toMatchObject({ name: 'ClusterRuntimeSpawnFailed' });
    expect(child.isRunning()).toBe(false);
  });

  it('bounds readiness waits and terminates the exact detached process group', async () => {
    const child = harness('setInterval(() => {}, 1000);', {
      startTimeoutMs: 50,
      stopTimeoutMs: 100,
    });

    await expect(child.start()).rejects.toMatchObject({ name: 'ClusterRuntimeStartTimeout' });
    expect(child.isRunning()).toBe(false);
  });

  it('falls back from bounded SIGTERM to SIGKILL for an uncooperative process', async () => {
    const source = `
      process.on('SIGTERM', () => {});
      process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const child = harness(source, { stopTimeoutMs: 100 });
    await child.start();

    await child.terminate();
    expect(child.isRunning()).toBe(false);
  });

  it('redacts connection strings, instance identifiers and process coordinates', () => {
    const redacted = redactClusterDiagnostic(
      'postgresql://user:secret@db.internal:5432/app redis://:secret@127.0.0.1:6379 pinst_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa pid=123 port: 4567',
    );

    expect(redacted).toContain('[connection-redacted]');
    expect(redacted).toContain('[instance-redacted]');
    expect(redacted).toContain('[process-redacted]');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain('5432');
    expect(redacted).not.toContain('6379');
    expect(redacted).not.toContain('123');
  });

  it('bounds total stdout even when every protocol line is valid', async () => {
    const source = `
      process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
      setInterval(() => process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n'), 1);
    `;
    const child = new ClusterProcessHarness({
      args: ['-e', source],
      command: bunExecutable,
      cwd,
      env: { PATH: process.env.PATH },
      outputLimitBytes: 128,
      requestTimeoutMs: 500,
    });
    children.push(child);
    await child.start();

    await expect.poll(() => child.isRunning(), { interval: 10, timeout: 2_000 }).toBe(false);
    expect(child.getDiagnostics()).toEqual({
      observedBytes: expect.any(Number),
      truncated: true,
    });
  });

  it('bounds cumulative redacted stderr and terminates the process', async () => {
    const source = `
      process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
      setInterval(() => process.stderr.write('redis://user:secret@127.0.0.1:6379\\n'), 1);
    `;
    const child = new ClusterProcessHarness({
      args: ['-e', source],
      command: bunExecutable,
      cwd,
      env: { PATH: process.env.PATH },
      outputLimitBytes: 128,
      requestTimeoutMs: 500,
    });
    children.push(child);
    await child.start();

    await expect.poll(() => child.isRunning(), { interval: 10, timeout: 2_000 }).toBe(false);
    expect(child.getDiagnostics()).toEqual({
      observedBytes: expect.any(Number),
      truncated: true,
    });
  });
});

describe('LoopbackFaultProxy', () => {
  it('rejects non-loopback upstreams and invalid ports', () => {
    expect(
      () => new LoopbackFaultProxy({ upstreamHost: 'redis.internal', upstreamPort: 6379 }),
    ).toThrowError(expect.objectContaining({ name: 'FaultProxyInvalidUpstream' }));
    expect(
      () => new LoopbackFaultProxy({ upstreamHost: '127.0.0.1', upstreamPort: 0 }),
    ).toThrowError(expect.objectContaining({ name: 'FaultProxyInvalidUpstream' }));
  });

  it('destroys existing and new sockets during a partition, then accepts traffic after healing', async () => {
    const upstream = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => upstream.listen({ host: '127.0.0.1', port: 0 }, resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Test upstream unavailable');
    const proxy = new LoopbackFaultProxy({ upstreamHost: '127.0.0.1', upstreamPort: address.port });
    const proxyPort = await proxy.start();

    try {
      const first = await connectSocket(proxyPort);
      const firstClosed = once(first, 'close');
      proxy.setPartitioned(true);
      const rejected = await connectSocket(proxyPort);
      await Promise.all([firstClosed, once(rejected, 'close')]);

      proxy.setPartitioned(false);
      const healed = await connectSocket(proxyPort);
      const echoed = once(healed, 'data');
      healed.write('healthy');
      const [data] = await echoed;
      expect(data.toString()).toBe('healthy');
      healed.end();
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
