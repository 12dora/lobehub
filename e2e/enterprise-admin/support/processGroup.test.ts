import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  isPidAlive,
  isProcessGroupAlive,
  listPidsInProcessGroup,
  listPidsInProcessGroupForTests,
  refreshOwnedProcessGroupEvidence,
  registerProcess,
  setListPidsInProcessGroupOverride,
} from './lifecycle';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('owned process group enumeration', () => {
  afterEach(() => {
    setListPidsInProcessGroupOverride(null);
  });

  it('enumerates real child/grandchild in detached group; cleanup kills only that PGID', async () => {
    const state = createLifecycleState(createRunToken());
    const leader = spawn(
      process.execPath,
      [
        '-e',
        `
        const {spawn}=require('child_process');
        spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:false,stdio:'ignore'});
        setInterval(()=>{},1000);
        `,
      ],
      { detached: true, stdio: 'ignore' },
    );
    registerProcess(state, leader);
    expect(leader.pid).toBeTruthy();
    for (let i = 0; i < 40; i++) {
      const members = await listPidsInProcessGroup(leader.pid!);
      await refreshOwnedProcessGroupEvidence(state, leader.pid!);
      if (members.length >= 2 && state.evidenceDescendants.length > 0) break;
      await sleep(50);
    }
    // Final refresh after group is populated
    await refreshOwnedProcessGroupEvidence(state, leader.pid!);
    const members = await listPidsInProcessGroup(leader.pid!);
    expect(members.length).toBeGreaterThanOrEqual(2);
    expect(state.evidenceDescendants.length).toBeGreaterThan(0);
    expect(state.evidenceDescendants.some((p) => p !== leader.pid)).toBe(true);
    expect(state.evidencePgids).toContain(leader.pid!);

    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    await sleep(100);
    expect(isPidAlive(foreign.pid)).toBe(true);

    await cleanupLifecycle(state);
    expect(isPidAlive(leader.pid)).toBe(false);
    for (const d of state.evidenceDescendants) {
      expect(isPidAlive(d)).toBe(false);
    }
    expect(isProcessGroupAlive(leader.pid)).toBe(false);
    expect(isPidAlive(foreign.pid)).toBe(true);
    try {
      if (foreign.pid) process.kill(-foreign.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }, 30_000);

  it('pgrep unavailable falls back to ps or fails loud (never silent empty on tooling error)', async () => {
    const empty = await listPidsInProcessGroup(999_999_991);
    expect(empty).toEqual([]);

    setListPidsInProcessGroupOverride(async (pgid) => [pgid, pgid + 1]);
    await expect(listPidsInProcessGroupForTests(42)).resolves.toEqual([42, 43]);
  });
});
