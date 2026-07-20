import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  isPidAlive,
  isProcessGroupAlive,
  killOwnedProcessGroupByPgid,
  listPidsInProcessGroup,
  refreshOwnedProcessGroupEvidence,
  registerOwnedProcessGroup,
  registerProcess,
  setProcessEnumExecForTests,
  spawnOwned,
} from './lifecycle';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('owned process group enumeration and cleanup', () => {
  afterEach(() => {
    setProcessEnumExecForTests(null);
  });

  it('leader exits first with child still alive: durable PGID cleanup reaps group', async () => {
    const state = createLifecycleState(createRunToken());
    // Leader spawns child then exits immediately; child stays alive in same PGID.
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `
        const {spawn}=require('child_process');
        const c=spawn(process.execPath,['-e','setInterval(()=>{},200)'],{detached:false,stdio:'ignore'});
        // exit quickly so leader is gone before cleanup
        setTimeout(()=>process.exit(0), 80);
        `,
      ],
      { detached: true, stdio: 'ignore' },
    );
    registerProcess(state, leader);
    expect(leader.pid).toBeTruthy();
    const pgid = leader.pid!;

    // Wait for leader exit while child remains
    await new Promise<void>((resolve) => {
      if (leader.exitCode !== null) return resolve();
      leader.once('exit', () => resolve());
    });
    // Remove from live registry the same way runOwnedCommand does
    const idx = state.processes.indexOf(leader);
    if (idx >= 0) state.processes.splice(idx, 1);
    expect(state.processes).toHaveLength(0);
    expect(state.ownedProcessGroups.some((g) => g.pgid === pgid)).toBe(true);

    // Child still in group
    let members: number[] = [];
    for (let i = 0; i < 40; i++) {
      members = await listPidsInProcessGroup(pgid);
      if (members.length > 0) break;
      await sleep(30);
    }
    expect(members.length).toBeGreaterThan(0);
    await refreshOwnedProcessGroupEvidence(state, pgid);
    expect(state.evidenceDescendants.length + state.evidencePids.length).toBeGreaterThan(0);

    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},200)'], {
      detached: true,
      stdio: 'ignore',
    });
    await sleep(50);
    expect(isPidAlive(foreign.pid)).toBe(true);

    await cleanupLifecycle(state);
    expect(state.ownedProcessGroups).toHaveLength(0);
    expect(isProcessGroupAlive(pgid)).toBe(false);
    for (const m of members) {
      expect(isPidAlive(m)).toBe(false);
    }
    // Unrelated foreign group survives
    expect(isPidAlive(foreign.pid)).toBe(true);
    try {
      if (foreign.pid) process.kill(-foreign.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }, 30_000);

  it('SIGTERM-ignoring descendant is SIGKILL’d via exact owned PGID', async () => {
    const state = createLifecycleState(createRunToken());
    // Child ignores SIGTERM (trap), dies only on SIGKILL
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `
        const {spawn}=require('child_process');
        spawn(process.execPath,['-e',
          "process.on('SIGTERM',()=>{}); setInterval(()=>{},200);"
        ],{detached:false,stdio:'ignore'});
        setInterval(()=>{},200);
        `,
      ],
      { detached: true, stdio: 'ignore' },
    );
    registerProcess(state, leader);
    const pgid = leader.pid!;
    for (let i = 0; i < 40; i++) {
      await refreshOwnedProcessGroupEvidence(state, pgid);
      const m = await listPidsInProcessGroup(pgid);
      if (m.length >= 2 && state.evidenceDescendants.length > 0) break;
      await sleep(40);
    }
    expect(state.evidenceDescendants.length).toBeGreaterThan(0);

    await cleanupLifecycle(state);
    expect(isProcessGroupAlive(pgid)).toBe(false);
    expect(isPidAlive(leader.pid)).toBe(false);
    for (const d of state.evidenceDescendants) {
      expect(isPidAlive(d)).toBe(false);
    }
  }, 30_000);

  it('pgrep exit 1 is empty; other failures use ps; both failing throws', async () => {
    // exit 1 → empty
    setProcessEnumExecForTests(async (file, args) => {
      if (file === 'pgrep') {
        const err = Object.assign(new Error('no process'), { code: 1, status: 1 });
        throw err;
      }
      throw new Error(`unexpected ${file} ${args.join(' ')}`);
    });
    await expect(listPidsInProcessGroup(999_999_991)).resolves.toEqual([]);

    // pgrep ENOENT → ps fallback returns members
    setProcessEnumExecForTests(async (file) => {
      if (file === 'pgrep') {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      }
      if (file === 'ps') {
        return { stdout: '  11111  4242\n  22222  4242\n  33333  9999\n' };
      }
      throw new Error(`unexpected ${file}`);
    });
    await expect(listPidsInProcessGroup(4242)).resolves.toEqual([11_111, 22_222]);

    // both fail → throw
    setProcessEnumExecForTests(async () => {
      throw Object.assign(new Error('broken'), { code: 'ENOENT' });
    });
    await expect(listPidsInProcessGroup(1)).rejects.toThrow(/failed to enumerate process group/);
  });

  it('registerOwnedProcessGroup is cleanup authority independent of processes registry', async () => {
    const state = createLifecycleState(createRunToken());
    const child = spawnOwned(state, process.execPath, ['-e', 'setInterval(()=>{},200)'], {
      stdio: 'ignore',
    });
    expect(child.pid).toBeTruthy();
    registerOwnedProcessGroup(state, child.pid!);
    // Empty registry but durable ownership remains
    state.processes.length = 0;
    expect(state.ownedProcessGroups).toHaveLength(1);
    await killOwnedProcessGroupByPgid(child.pid!);
    expect(isPidAlive(child.pid)).toBe(false);
  }, 15_000);
});
