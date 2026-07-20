import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { holdPort, probeAppBindOrFail } from './infrastructure';
import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  type LifecycleState,
  registerProcess,
} from './lifecycle';

/**
 * Deterministic delayed bind collision: competitor grabs port after release,
 * spawn delayed >800ms. Must fail the attempt promptly and retry on a free port
 * — never hang for 240s.
 */
describe('app port handoff delayed TOCTOU', () => {
  const open: LifecycleState[] = [];

  afterEach(async () => {
    while (open.length > 0) {
      const state = open.pop()!;
      await cleanupLifecycle(state).catch(() => undefined);
    }
  });

  it('retries promptly when competitor grabs port after release with delayed bind', async () => {
    const runToken = createRunToken();
    const state = createLifecycleState(runToken);
    open.push(state);

    const started = Date.now();

    // Attempt 1: release → competitor → delayed spawn → bind fail → kill
    const held = await holdPort();
    const firstPort = held.port;
    await held.release();

    const competitor: Server = createServer();
    await new Promise<void>((resolve, reject) => {
      competitor.once('error', reject);
      competitor.listen(firstPort, '127.0.0.1', () => resolve());
    });

    await new Promise((r) => setTimeout(r, 1200)); // >800ms delay (old false-pass window)

    const child1 = spawn(
      process.execPath,
      [
        '-e',
        `require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1').on('error',e=>{console.error(e);process.exit(1)})`,
      ],
      {
        detached: true,
        env: { ...process.env, PORT: String(firstPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    registerProcess(state, child1);

    await expect(
      probeAppBindOrFail({ appPort: firstPort, child: child1, timeoutMs: 3_000 }),
    ).rejects.toThrow(/EADDRINUSE|exited|bind/i);

    try {
      if (child1.pid) process.kill(-child1.pid, 'SIGKILL');
    } catch {
      //
    }
    await new Promise<void>((resolve) => competitor.close(() => resolve()));

    // Attempt 2: free port succeeds quickly
    const held2 = await holdPort();
    const port2 = held2.port;
    await held2.release();
    const child2 = spawn(
      process.execPath,
      [
        '-e',
        `require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')`,
      ],
      {
        detached: true,
        env: { ...process.env, PORT: String(port2) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    registerProcess(state, child2);
    await probeAppBindOrFail({ appPort: port2, child: child2, timeoutMs: 3_000 });

    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(30_000); // prompt retry, not 240s hang
    expect(port2).not.toBe(firstPort);

    await cleanupLifecycle(state);
    open.pop();
  }, 45_000);
});
