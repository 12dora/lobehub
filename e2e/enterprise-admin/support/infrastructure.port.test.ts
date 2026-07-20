import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { startAppWithPortRetry } from './infrastructure';
import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  type LifecycleState,
  registerProcess,
} from './lifecycle';

/**
 * Deterministic delayed bind collision through production startAppWithPortRetry.
 * Competitor grabs port after release; spawn delayed 1200ms (>800ms). Production
 * orchestration must detect failure, reap first child, retry on a new port, and
 * return a healthy second attempt under a short bound.
 */
describe('app port handoff delayed TOCTOU via startAppWithPortRetry', () => {
  const open: LifecycleState[] = [];
  const competitors: Server[] = [];

  afterEach(async () => {
    while (competitors.length > 0) {
      const c = competitors.pop()!;
      await new Promise<void>((resolve) => c.close(() => resolve()));
    }
    while (open.length > 0) {
      const state = open.pop()!;
      await cleanupLifecycle(state).catch(() => undefined);
    }
  });

  it('production startAppWithPortRetry reaps failed attempt and retries promptly', async () => {
    const runToken = createRunToken();
    const state = createLifecycleState(runToken);
    open.push(state);

    let attempt = 0;
    let firstPort: number | undefined;
    let competitor: Server | undefined;
    const started = Date.now();

    const result = await startAppWithPortRetry({
      attempts: 4,
      databaseUrl: 'postgresql://unused',
      hooks: {
        afterPortRelease: async ({ appPort }) => {
          attempt += 1;
          if (attempt === 1) {
            firstPort = appPort;
            competitor = createServer();
            competitors.push(competitor);
            await new Promise<void>((resolve, reject) => {
              competitor!.once('error', reject);
              competitor!.listen(appPort, '127.0.0.1', () => resolve());
            });
          } else if (competitor) {
            // Release competitor so second attempt can bind.
            await new Promise<void>((resolve) => competitor!.close(() => resolve()));
            const idx = competitors.indexOf(competitor);
            if (idx >= 0) competitors.splice(idx, 1);
            competitor = undefined;
          }
        },
        bindDelayMs: 1200, // >800ms old false-pass window
        bindProbeTimeoutMs: 2500,
        spawnApp: ({ appPort, env, state: st }) => {
          // Controlled HTTP server: fails if port taken; succeeds when free.
          const child = spawn(
            process.execPath,
            [
              '-e',
              `require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1').on('error',e=>{console.error(e);process.exit(1)})`,
            ],
            {
              detached: true,
              env: { ...env, PORT: String(appPort) },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          registerProcess(st, child);
          return child;
        },
      },
      mode: 'dev',
      redisUrl: 'redis://unused',
      state,
    });

    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(30_000);
    expect(firstPort).toBeDefined();
    expect(result.appPort).not.toBe(firstPort);
    expect(result.child.exitCode).toBeNull();
    expect(state.processes).toContain(result.child);

    // Reap healthy child via lifecycle
    await cleanupLifecycle(state);
    open.pop();
    expect(state.processes).toHaveLength(0);
  }, 45_000);
});
