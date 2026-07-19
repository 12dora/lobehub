import { createServer, get } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { RestartingWebServer } from './restartingWebServer';

let supervisor: RestartingWebServer | undefined;

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
});

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('port unavailable'));
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const childScript = `
  const http = require('node:http');
  const server = http.createServer((_req, res) => res.end('ok'));
  server.listen(Number(process.env.TEST_PORT), '127.0.0.1');
`;

const assertReachable = async (port: number) =>
  new Promise<void>((resolve, reject) => {
    get(`http://127.0.0.1:${port}`, (response) => {
      response.resume();
      response.once('end', resolve);
    }).once('error', reject);
  });

describe('RestartingWebServer', () => {
  it('respawns only after an expected SIGTERM with a new PID and generation', async () => {
    const port = await freePort();
    supervisor = new RestartingWebServer({
      command: [process.execPath, '-e', childScript],
      cwd: process.cwd(),
      env: { ...process.env, TEST_PORT: String(port) },
      healthUrl: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 10_000,
    });
    await supervisor.start();
    const oldPid = supervisor.pid!;
    process.kill(oldPid, 'SIGTERM');
    await supervisor.waitForGeneration(2);
    expect(supervisor.pid).not.toBe(oldPid);
    expect(supervisor.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ generation: 1, pid: oldPid, signal: 'SIGTERM', type: 'exit' }),
        expect.objectContaining({ generation: 2, type: 'start' }),
      ]),
    );
    await assertReachable(port);
  });

  it('treats an unexpected exit as fatal and does not respawn', async () => {
    const port = await freePort();
    supervisor = new RestartingWebServer({
      command: [process.execPath, '-e', childScript],
      cwd: process.cwd(),
      env: { ...process.env, TEST_PORT: String(port) },
      healthUrl: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 10_000,
    });
    await supervisor.start();
    process.kill(supervisor.pid!, 'SIGKILL');
    await expect(supervisor.fatal).rejects.toThrow('exited unexpectedly');
    expect(supervisor.currentGeneration).toBe(1);
  });

  it('accepts the conventional 143 exit reported by a SIGTERM handler', async () => {
    const port = await freePort();
    const handledSigtermScript = `${childScript}
      process.on('SIGTERM', () => process.exit(143));
    `;
    supervisor = new RestartingWebServer({
      command: [process.execPath, '-e', handledSigtermScript],
      cwd: process.cwd(),
      env: { ...process.env, TEST_PORT: String(port) },
      healthUrl: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 10_000,
    });
    await supervisor.start();
    const oldPid = supervisor.pid!;
    process.kill(oldPid, 'SIGTERM');
    await supervisor.waitForGeneration(2);
    expect(supervisor.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 143, generation: 1, signal: null, type: 'exit' }),
        expect.objectContaining({ generation: 2, type: 'start' }),
      ]),
    );
    expect(supervisor.pid).not.toBe(oldPid);
  });

  it('sets the stop flag before terminating the process group and performs no respawn', async () => {
    const port = await freePort();
    supervisor = new RestartingWebServer({
      command: [process.execPath, '-e', childScript],
      cwd: process.cwd(),
      env: { ...process.env, TEST_PORT: String(port) },
      healthUrl: `http://127.0.0.1:${port}`,
      port,
      startupTimeoutMs: 10_000,
    });
    await supervisor.start();
    await supervisor.stop();
    expect(supervisor.currentGeneration).toBe(1);
    expect(supervisor.events.at(-1)).toMatchObject({ signal: 'SIGTERM', type: 'exit' });
  });

  it('escalates a stubborn child to SIGKILL and waits for confirmed exit', async () => {
    const port = await freePort();
    const stubbornScript = `
      const http = require('node:http');
      const server = http.createServer((_req, res) => res.end('ok'));
      server.listen(Number(process.env.TEST_PORT), '127.0.0.1');
      process.on('SIGTERM', () => {});
    `;
    supervisor = new RestartingWebServer({
      command: [process.execPath, '-e', stubbornScript],
      cwd: process.cwd(),
      env: { ...process.env, TEST_PORT: String(port) },
      healthUrl: `http://127.0.0.1:${port}`,
      killTimeoutMs: 100,
      port,
      startupTimeoutMs: 10_000,
    });
    await supervisor.start();
    await supervisor.stop();
    expect(supervisor.events.at(-1)).toMatchObject({ signal: 'SIGKILL', type: 'exit' });
    expect(supervisor.pid).toBeUndefined();
    expect(supervisor.currentGeneration).toBe(1);
  });
});
