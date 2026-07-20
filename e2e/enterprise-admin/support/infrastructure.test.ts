import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveRuntimeMode } from './infrastructure';
import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  type LifecycleState,
  registerProcess,
  startOwnedContainer,
} from './lifecycle';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('port'));
      const port = address.port;
      server.close(() => resolve(port));
    });
  });

const containerExists = (id: string): boolean => {
  try {
    execFileSync('docker', ['inspect', id], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('resolveRuntimeMode', () => {
  it('defaults to isolated and ignores bare BASE_URL', () => {
    expect(
      resolveRuntimeMode({
        BASE_URL: 'http://localhost:3010',
        DATABASE_URL: 'postgresql://x',
      }),
    ).toBe('isolated');
  });

  it('blocks external without disposable-db gate', () => {
    expect(() =>
      resolveRuntimeMode({
        BASE_URL: 'http://localhost:3010',
        DATABASE_URL: 'postgresql://x',
        E2E_ENTERPRISE_ADMIN_EXTERNAL: '1',
      }),
    ).toThrow(/DISPOSABLE_DB/);
  });

  it('allows external only with disposable gate + urls', () => {
    expect(
      resolveRuntimeMode({
        BASE_URL: 'http://localhost:3010',
        DATABASE_URL: 'postgresql://x',
        E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB: '1',
        E2E_ENTERPRISE_ADMIN_EXTERNAL: '1',
      }),
    ).toBe('external');
  });
});

/**
 * Fault-injection cleanup for every startup stage the suite can fail at:
 * 1) after first container (postgres-stage)
 * 2) after second container (redis-stage)
 * 3) after process registration (app/migrate-stage simulation)
 * Cleanup must remove only this run's owned IDs and leave no leftovers.
 */
describe('lifecycle ownership cleanup at every startup stage', () => {
  const openStates: Array<{ runToken: string; state: LifecycleState }> = [];

  afterEach(async () => {
    for (const entry of openStates.splice(0)) {
      await cleanupLifecycle(entry.state).catch(() => undefined);
    }
  });

  const track = (runToken: string, state: LifecycleState) => {
    openStates.push({ runToken, state });
    return state;
  };

  it('stage:postgres — cleans single owned container after simulated PG-wait failure', async () => {
    const runToken = createRunToken();
    const state = track(runToken, createLifecycleState(runToken));
    const port = await freePort();
    await startOwnedContainer({
      args: [
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-e',
        'POSTGRES_DB=fault_pg',
        '-p',
        `127.0.0.1:${port}:5432`,
      ],
      image: 'paradedb/paradedb:latest-pg17',
      name: `aihub-admin-fault-pg-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    expect(state.containers).toHaveLength(1);
    const id = state.containers[0].id;
    expect(containerExists(id)).toBe(true);
    // Simulated failure before redis / migrate
    await cleanupLifecycle(state);
    expect(state.containers).toHaveLength(0);
    expect(containerExists(id)).toBe(false);
  }, 90_000);

  it('stage:redis — cleans PG+Redis after simulated migrate failure', async () => {
    const runToken = createRunToken();
    const state = track(runToken, createLifecycleState(runToken));
    const pgPort = await freePort();
    const redisPort = await freePort();
    await startOwnedContainer({
      args: [
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-e',
        'POSTGRES_DB=fault_both',
        '-p',
        `127.0.0.1:${pgPort}:5432`,
      ],
      image: 'paradedb/paradedb:latest-pg17',
      name: `aihub-admin-fault-pg2-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    await startOwnedContainer({
      args: ['-p', `127.0.0.1:${redisPort}:6379`],
      image: 'redis:7-alpine',
      name: `aihub-admin-fault-redis-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    expect(state.containers).toHaveLength(2);
    const ids = state.containers.map((c) => c.id);
    await cleanupLifecycle(state);
    expect(state.containers).toHaveLength(0);
    for (const id of ids) {
      expect(containerExists(id)).toBe(false);
    }
    // Label sweep: no leftovers for this token
    const leftover = execFileSync(
      'docker',
      ['ps', '-aq', '--filter', `label=lobehub.e2e.run=${runToken}`],
      { encoding: 'utf8' },
    ).trim();
    expect(leftover).toBe('');
  }, 120_000);

  it('stage:process — terminates owned process group after simulated app boot failure', async () => {
    const runToken = createRunToken();
    const state = track(runToken, createLifecycleState(runToken));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    registerProcess(state, child);
    expect(child.pid).toBeTruthy();
    // Give the child a moment to be alive
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    await cleanupLifecycle(state);
    expect(state.processes).toHaveLength(0);
    // Process must be gone (ESRCH on kill 0)
    let alive = true;
    try {
      process.kill(child.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 30_000);

  it('refuses foreign ownership: only removes containers labeled with this run token', async () => {
    const runToken = createRunToken();
    const foreignToken = createRunToken();
    const state = track(runToken, createLifecycleState(runToken));
    const foreignState = track(foreignToken, createLifecycleState(foreignToken));
    const portA = await freePort();
    const portB = await freePort();
    await startOwnedContainer({
      args: ['-p', `127.0.0.1:${portA}:6379`],
      image: 'redis:7-alpine',
      name: `aihub-admin-own-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    await startOwnedContainer({
      args: ['-p', `127.0.0.1:${portB}:6379`],
      image: 'redis:7-alpine',
      name: `aihub-admin-foreign-${foreignToken.slice(-10)}`,
      runToken: foreignToken,
      state: foreignState,
    });
    const ownId = state.containers[0].id;
    const foreignId = foreignState.containers[0].id;
    await cleanupLifecycle(state);
    expect(containerExists(ownId)).toBe(false);
    expect(containerExists(foreignId)).toBe(true);
    await cleanupLifecycle(foreignState);
    expect(containerExists(foreignId)).toBe(false);
  }, 60_000);
});
