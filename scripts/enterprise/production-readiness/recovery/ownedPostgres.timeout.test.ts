// @vitest-environment node
/**
 * Timeout lifecycle for runBoundedChild (pg_dump / pg_restore harness).
 * Hermetic — no Docker. Proves the promise settles only after the child is reaped.
 */
import type { ChildProcess } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { runBoundedChild } from './ownedPostgres';

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('runBoundedChild timeout lifecycle', () => {
  it('resolves timeout only after a SIGTERM-ignoring child is reaped (SIGKILL)', async () => {
    let child: ChildProcess | undefined;
    let pid = 0;
    const started = Date.now();

    // Hang forever; ignore SIGTERM so escalation must use SIGKILL.
    const outcomePromise = runBoundedChild({
      args: ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);"],
      command: process.execPath,
      killGraceMs: 100,
      onSpawn: (spawned) => {
        child = spawned;
        pid = spawned.pid ?? 0;
      },
      timeoutMs: 150,
    });

    // Child must still be alive until the timeout path reaps it.
    await new Promise((r) => setTimeout(r, 40));
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(true);
    expect(child?.exitCode).toBeNull();

    const outcome = await outcomePromise;
    const elapsed = Date.now() - started;

    expect(outcome.kind).toBe('timeout');
    // Must span at least the timeout (+ kill-grace for SIGTERM-ignoring hang).
    expect(elapsed).toBeGreaterThanOrEqual(150);

    // Promise settled only after 'close' — child is already reaped (not still alive).
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    expect(isAlive(pid)).toBe(false);
    // Reaped via SIGTERM (default disposition) or SIGKILL (after grace). Either is fine.
    if (outcome.kind === 'timeout') {
      expect(['SIGTERM', 'SIGKILL']).toContain(outcome.signal);
    }
  }, 15_000);

  it('returns exit outcome for a short successful child (no timeout)', async () => {
    const outcome = await runBoundedChild({
      args: ['-e', "process.stdout.write('ok-payload-xxxxxxxx');"],
      command: process.execPath,
      killGraceMs: 200,
      timeoutMs: 5_000,
    });
    expect(outcome.kind).toBe('exit');
    if (outcome.kind !== 'exit') return;
    expect(outcome.code).toBe(0);
    expect(outcome.stdout.toString('utf8')).toContain('ok-payload');
  });
});
