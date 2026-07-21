import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { holdPort, resolveRuntimeMode } from './infrastructure';
import {
  assertNoOwnedContainersRemain,
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  inspectPublishedHostPort,
  type LifecycleState,
  listContainersByRunToken,
  registerProcess,
  removeOwnedContainer,
  startOwnedContainer,
} from './lifecycle';

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

describe('holdPort reservation (no freePort TOCTOU for app)', () => {
  it('holds the port so a parallel bind fails until release', async () => {
    const held = await holdPort();
    await new Promise<void>((resolve, reject) => {
      const competitor = createServer();
      competitor.once('error', (error: NodeJS.ErrnoException) => {
        expect(error.code).toBe('EADDRINUSE');
        resolve();
      });
      competitor.listen(held.port, '127.0.0.1', () => {
        competitor.close();
        reject(new Error('competitor should not have bound held port'));
      });
    });
    await held.release();
    // After release, bind succeeds
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(held.port, '127.0.0.1', () => {
        server.close(() => resolve());
      });
    });
  });

  it('parallel holdPort stress: many reservations are unique', async () => {
    const held = await Promise.all(Array.from({ length: 20 }, () => holdPort()));
    const ports = held.map((h) => h.port);
    expect(new Set(ports).size).toBe(20);
    await Promise.all(held.map((h) => h.release()));
  }, 30_000);
});

describe('docker ephemeral host port publish', () => {
  const openStates: Array<{ runToken: string; state: LifecycleState }> = [];

  afterEach(async () => {
    for (const entry of openStates.splice(0)) {
      await cleanupLifecycle(entry.state).catch(() => undefined);
    }
  });

  it('publishes redis with 127.0.0.1::6379 and inspects assigned host port', async () => {
    const runToken = createRunToken();
    const state = createLifecycleState(runToken);
    openStates.push({ runToken, state });
    const owned = await startOwnedContainer({
      args: ['-p', '127.0.0.1::6379'],
      image: 'redis:7-alpine',
      name: `aihub-admin-ephem-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    const hostPort = await inspectPublishedHostPort(owned.id, 6379);
    expect(hostPort).toBeGreaterThan(0);
    // Port is actually listening via docker
    await new Promise<void>((resolve, reject) => {
      const net = require('node:net');
      const socket = net.connect({ host: '127.0.0.1', port: hostPort }, () => {
        socket.end();
        resolve();
      });
      socket.once('error', reject);
    });
    await cleanupLifecycle(state);
    await assertNoOwnedContainersRemain(runToken);
  }, 60_000);
});

describe('ownership guard must not remove foreign containers', () => {
  const openStates: Array<{ runToken: string; state: LifecycleState }> = [];

  afterEach(async () => {
    for (const entry of openStates.splice(0)) {
      await cleanupLifecycle(entry.state).catch(() => undefined);
    }
  });

  it('same container ID + wrong expected label rethrows and leaves container', async () => {
    const runToken = createRunToken();
    const foreignToken = createRunToken();
    const state = createLifecycleState(runToken);
    openStates.push({ runToken, state });
    openStates.push({ runToken: foreignToken, state: createLifecycleState(foreignToken) });

    const owned = await startOwnedContainer({
      args: ['-p', '127.0.0.1::6379'],
      image: 'redis:7-alpine',
      name: `aihub-admin-own-label-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    expect(containerExists(owned.id)).toBe(true);

    // Same ID, wrong expected token — must refuse and leave container running.
    await expect(
      removeOwnedContainer({
        expectedRunToken: 'wrong-token-must-not-delete',
        id: owned.id,
        name: owned.name,
      }),
    ).rejects.toThrow(/ownership label mismatch/);

    expect(containerExists(owned.id)).toBe(true);
    // Legitimate cleanup still works
    await removeOwnedContainer(owned);
    expect(containerExists(owned.id)).toBe(false);
    state.containers.length = 0;
  }, 60_000);
});

/**
 * Fault-injection cleanup for every startup stage.
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
    await startOwnedContainer({
      args: [
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-e',
        'POSTGRES_DB=fault_pg',
        '-p',
        '127.0.0.1::5432',
      ],
      image: 'paradedb/paradedb:latest-pg17',
      name: `aihub-admin-fault-pg-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    expect(state.containers).toHaveLength(1);
    const id = state.containers[0].id;
    await cleanupLifecycle(state);
    expect(containerExists(id)).toBe(false);
    await assertNoOwnedContainersRemain(runToken);
  }, 90_000);

  it('stage:redis — cleans PG+Redis after simulated migrate failure', async () => {
    const runToken = createRunToken();
    const state = track(runToken, createLifecycleState(runToken));
    await startOwnedContainer({
      args: [
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-e',
        'POSTGRES_DB=fault_both',
        '-p',
        '127.0.0.1::5432',
      ],
      image: 'paradedb/paradedb:latest-pg17',
      name: `aihub-admin-fault-pg2-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    await startOwnedContainer({
      args: ['-p', '127.0.0.1::6379'],
      image: 'redis:7-alpine',
      name: `aihub-admin-fault-redis-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    const ids = state.containers.map((c) => c.id);
    await cleanupLifecycle(state);
    for (const id of ids) {
      expect(containerExists(id)).toBe(false);
    }
    expect(await listContainersByRunToken(runToken)).toEqual([]);
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
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    await cleanupLifecycle(state);
    expect(state.processes).toHaveLength(0);
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
    await startOwnedContainer({
      args: ['-p', '127.0.0.1::6379'],
      image: 'redis:7-alpine',
      name: `aihub-admin-own-${runToken.slice(-10)}`,
      runToken,
      state,
    });
    await startOwnedContainer({
      args: ['-p', '127.0.0.1::6379'],
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
