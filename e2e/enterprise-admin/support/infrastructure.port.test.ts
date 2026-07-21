import type { ChildProcess } from 'node:child_process';
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

const pidAlive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Production startAppWithPortRetry with delayed collision + first-child reap proof.
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

  it('production startAppWithPortRetry reaps first child before returning second', async () => {
    const runToken = createRunToken();
    const state = createLifecycleState(runToken);
    open.push(state);

    let attempt = 0;
    let firstPort: number | undefined;
    let competitor: Server | undefined;
    const spawned: ChildProcess[] = [];
    const failedAttempts: ChildProcess[] = [];
    /** Snapshots taken inside production hooks BEFORE success returns. */
    const reapProofBeforeReturn: Array<{
      exitCode: number | null;
      pidAlive: boolean;
      signalCode: NodeJS.Signals | null;
      stillInLifecycle: boolean;
    }> = [];
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
            await new Promise<void>((resolve) => competitor!.close(() => resolve()));
            const idx = competitors.indexOf(competitor);
            if (idx >= 0) competitors.splice(idx, 1);
            competitor = undefined;
          }
        },
        bindDelayMs: 1200,
        bindProbeTimeoutMs: 2500,
        onAttemptFailed: (child, failedAttempt) => {
          failedAttempts.push(child);
          // Production killOwnedChild has already waited for exit before this observer.
          reapProofBeforeReturn.push({
            exitCode: child.exitCode,
            pidAlive: pidAlive(child.pid),
            signalCode: child.signalCode,
            stillInLifecycle: state.processes.includes(child),
          });
          expect(failedAttempt).toBe(0);
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
          expect(pidAlive(child.pid)).toBe(false);
          expect(state.processes).not.toContain(child);
        },
        onSpawn: (child, spawnAttempt) => {
          spawned.push(child);
          // Second (healthy) spawn only happens after first was reaped.
          if (spawnAttempt >= 1 && spawned[0]) {
            expect(spawned[0].exitCode !== null || spawned[0].signalCode !== null).toBe(true);
            expect(pidAlive(spawned[0].pid)).toBe(false);
            expect(state.processes).not.toContain(spawned[0]);
          }
        },
        spawnApp: ({ appPort, env, state: st }) => {
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
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(failedAttempts.length).toBeGreaterThanOrEqual(1);
    expect(reapProofBeforeReturn.length).toBeGreaterThanOrEqual(1);
    expect(reapProofBeforeReturn[0].pidAlive).toBe(false);
    expect(reapProofBeforeReturn[0].stillInLifecycle).toBe(false);
    expect(
      reapProofBeforeReturn[0].exitCode !== null || reapProofBeforeReturn[0].signalCode !== null,
    ).toBe(true);

    const first = spawned[0];
    // At resolve: only the healthy second child remains in lifecycle state.
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true);
    expect(pidAlive(first.pid)).toBe(false);
    expect(state.processes).not.toContain(first);
    expect(state.processes).toEqual([result.child]);

    expect(result.child).toBe(spawned.at(-1));
    expect(result.child.exitCode).toBeNull();
    expect(firstPort).toBeDefined();
    expect(result.appPort).not.toBe(firstPort);

    await cleanupLifecycle(state);
    open.pop();
    expect(state.processes).toHaveLength(0);
    expect(pidAlive(result.child.pid)).toBe(false);
  }, 45_000);
});
