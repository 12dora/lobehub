/**
 * Commit / lifecycle contract tests: early fail, mid-txn rollback, post-COMMIT
 * reporting failure, ambiguous COMMIT, terminate bounds. Each case owns its own ParadeDB.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { digestFingerprint, snapshotGlobalDbDigest } from './seed';
import { startCasPostgres } from './seed.casHarness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('seed commit lifecycle contracts', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const stop = cleanups.pop()!;
      await stop().catch(() => undefined);
    }
  }, 60_000);

  it('early seed failure: real lifecycle hook leaves before digest (no manual cleanup)', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      registerSeedRestoreOnLifecycle,
      seedEnterpriseAdminSuite: seedFn,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    const beforeListeners = process.listenerCount('SIGINT');
    installLifecycleSignalHandlers(state);
    expect(process.listenerCount('SIGINT')).toBe(beforeListeners + 1);
    expect(state.signalHandlersInstalled).toBe(true);
    registerSeedRestoreOnLifecycle(state, durable, { settleTimeoutMs: 2_000 });

    process.env.E2E_CAS_FORCE_EARLY_FAIL = '1';
    try {
      await expect(seedFn(harness.databaseUrl, durable)).rejects.toThrow(
        /forced early seed failure/,
      );
    } finally {
      delete process.env.E2E_CAS_FORCE_EARLY_FAIL;
    }
    expect(durable.settled).toBe(true);
    expect(durable.commitPhase).toBe('notStarted');
    expect(durable.committed).toBe(false);

    await cleanupLifecycle(state);
    expect(state.signalHandlersInstalled).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(beforeListeners);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
  }, 60_000);

  it('mid-transaction rollback: real lifecycle hook leaves before digest', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      registerSeedRestoreOnLifecycle,
      seedEnterpriseAdminSuite: seedFn,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    installLifecycleSignalHandlers(state);
    registerSeedRestoreOnLifecycle(state, durable, { settleTimeoutMs: 2_000 });

    process.env.E2E_CAS_FORCE_TXN_ROLLBACK = '1';
    try {
      await expect(seedFn(harness.databaseUrl, durable)).rejects.toThrow(
        /forced mid-transaction rollback/,
      );
    } finally {
      delete process.env.E2E_CAS_FORCE_TXN_ROLLBACK;
    }
    expect(durable.commitPhase).toBe('rolledBack');
    expect(durable.committed).toBe(false);
    expect(durable.manifest).toBeNull();

    await cleanupLifecycle(state);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
  }, 60_000);

  it('forced post-COMMIT reporting failure: real cleanupLifecycle restores via hook only', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      registerSeedRestoreOnLifecycle,
      seedEnterpriseAdminSuite: seedFn,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    const beforeSig = process.listenerCount('SIGTERM');
    installLifecycleSignalHandlers(state);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSig + 1);
    registerSeedRestoreOnLifecycle(state, durable, { settleTimeoutMs: 2_000 });

    process.env.E2E_CAS_FORCE_POST_COMMIT_FAIL = '1';
    try {
      await expect(seedFn(harness.databaseUrl, durable)).rejects.toThrow(/forced post-COMMIT/);
    } finally {
      delete process.env.E2E_CAS_FORCE_POST_COMMIT_FAIL;
    }
    expect(durable.committed).toBe(true);
    expect(durable.commitPhase).toBe('committed');
    expect(durable.manifest).toBeTruthy();
    expect(durable.seed).toBeTruthy();
    // Pollution present before lifecycle restore
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).not.toBe(beforeFp);

    // Production path only — no manual cleanupEnterpriseAdminSuite, no clearing hooks
    await cleanupLifecycle(state);
    expect(state.signalHandlersInstalled).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSig);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
  }, 90_000);

  it('real COMMIT sent+landed, client result withheld: lifecycle restores digest', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      getActiveSettleTimerCount,
      registerSeedRestoreOnLifecycle,
      seedEnterpriseAdminSuite: seedFn,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    const hangDir = mkdtempSync(path.join(tmpdir(), 'cas-commit-landed-'));
    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    const baseSig = process.listenerCount('SIGINT');
    const baseTerm = process.listenerCount('SIGTERM');
    const timersBefore = getActiveSettleTimerCount();
    installLifecycleSignalHandlers(state);
    expect(process.listenerCount('SIGINT')).toBe(baseSig + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baseTerm + 1);
    registerSeedRestoreOnLifecycle(state, durable, { settleTimeoutMs: 1_500 });

    process.env.E2E_CAS_COMMIT_LANDED_CLIENT_UNKNOWN = '1';
    process.env.E2E_CAS_COMMIT_LANDED_HANG_DIR = hangDir;
    process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR = hangDir;
    const seedPromise = seedFn(harness.databaseUrl, durable).catch((e) => e);

    const issued = path.join(hangDir, 'commit-issued');
    const landed = path.join(hangDir, 'commit-landed');
    const deadline = Date.now() + 60_000;
    while ((!existsSync(issued) || !existsSync(landed)) && Date.now() < deadline) {
      await sleep(50);
    }
    expect(existsSync(issued)).toBe(true);
    expect(existsSync(landed)).toBe(true);
    // Real COMMIT landed — pollution visible
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).not.toBe(beforeFp);
    expect(durable.manifest).toBeTruthy();

    await cleanupLifecycle(state);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
    expect(process.listenerCount('SIGINT')).toBe(baseSig);
    expect(process.listenerCount('SIGTERM')).toBe(baseTerm);
    expect(getActiveSettleTimerCount()).toBe(timersBefore);

    writeFileSync(path.join(hangDir, 'release'), '1', 'utf8');
    await seedPromise;
    delete process.env.E2E_CAS_COMMIT_LANDED_CLIENT_UNKNOWN;
    delete process.env.E2E_CAS_COMMIT_LANDED_HANG_DIR;
    delete process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR;
    rmSync(hangDir, { force: true, recursive: true });
  }, 90_000);

  it('real COMMIT aborted by deferred constraint trigger: reconcile before-state', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      getActiveSettleTimerCount,
      registerSeedRestoreOnLifecycle,
      seedEnterpriseAdminSuite: seedFn,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    const hangDir = mkdtempSync(path.join(tmpdir(), 'cas-commit-raise-'));
    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    const timersBefore = getActiveSettleTimerCount();
    const baseSig = process.listenerCount('SIGINT');
    installLifecycleSignalHandlers(state);
    registerSeedRestoreOnLifecycle(state, durable, { settleTimeoutMs: 2_000 });

    process.env.E2E_CAS_COMMIT_DEFERRED_RAISE = '1';
    process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR = hangDir;
    try {
      await expect(seedFn(harness.databaseUrl, durable)).rejects.toThrow(
        /deferred COMMIT abort|e2e deferred|ambiguous|COMMIT/,
      );
    } finally {
      delete process.env.E2E_CAS_COMMIT_DEFERRED_RAISE;
      delete process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR;
    }
    // COMMIT was issued (marker) but aborted — no pollution
    expect(existsSync(path.join(hangDir, 'commit-issued'))).toBe(true);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);

    await cleanupLifecycle(state);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
    expect(process.listenerCount('SIGINT')).toBe(baseSig);
    expect(getActiveSettleTimerCount()).toBe(timersBefore);
    rmSync(hangDir, { force: true, recursive: true });
  }, 90_000);

  it('real COMMIT in-flight longer than settle timeout: fail-closed owned-backend resolve', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      getActiveSettleTimerCount,
      registerSeedRestoreOnLifecycle,
      seedEnterpriseAdminSuite: seedFn,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    const hangDir = mkdtempSync(path.join(tmpdir(), 'cas-commit-sleep-'));
    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    const timersBefore = getActiveSettleTimerCount();
    const baseSig = process.listenerCount('SIGINT');
    const baseTerm = process.listenerCount('SIGTERM');
    installLifecycleSignalHandlers(state);
    const settleMs = 800;
    registerSeedRestoreOnLifecycle(state, durable, { settleTimeoutMs: settleMs });

    // Deferred trigger sleeps 4s at COMMIT — longer than settle timeout
    process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS = '4000';
    process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR = hangDir;
    const seedPromise = seedFn(harness.databaseUrl, durable).catch((e) => e);

    const issued = path.join(hangDir, 'commit-issued');
    const deadline = Date.now() + 30_000;
    while (!existsSync(issued) && Date.now() < deadline) {
      await sleep(30);
    }
    expect(existsSync(issued)).toBe(true);
    expect(durable.commitPhase).toBe('commitIssued');
    expect(durable.commitInFlight).toBeTruthy();

    const started = Date.now();
    // Sample timer while cleanup is waiting
    let sawActiveTimer = false;
    const poll = setInterval(() => {
      if (getActiveSettleTimerCount() > timersBefore || durable.activeSettleTimers > 0) {
        sawActiveTimer = true;
      }
    }, 20);
    await cleanupLifecycle(state);
    clearInterval(poll);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(settleMs - 50);
    expect(elapsed).toBeLessThan(15_000);
    expect(sawActiveTimer).toBe(true);
    expect(durable.activeSettleTimers).toBe(0);
    expect(getActiveSettleTimerCount()).toBe(timersBefore);
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);
    expect(process.listenerCount('SIGINT')).toBe(baseSig);
    expect(process.listenerCount('SIGTERM')).toBe(baseTerm);

    await seedPromise;
    delete process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS;
    delete process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR;
    rmSync(hangDir, { force: true, recursive: true });
  }, 90_000);

  it('COMMIT in-flight + forced terminate failure: bounded fail-closed, journal preserved', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      getActiveSettleTimerCount,
      registerSeedRestoreOnLifecycle,
      seedEnterpriseAdminSuite: seedFn,
      terminateOwnedSeedBackend,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    const hangDir = mkdtempSync(path.join(tmpdir(), 'cas-term-fail-'));
    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    const timersBefore = getActiveSettleTimerCount();
    const baseSig = process.listenerCount('SIGINT');
    installLifecycleSignalHandlers(state);
    registerSeedRestoreOnLifecycle(state, durable, { settleTimeoutMs: 600 });

    process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS = '8000';
    process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR = hangDir;
    process.env.E2E_CAS_FORCE_TERMINATE_FAIL = '1';
    const seedPromise = seedFn(harness.databaseUrl, durable).catch((e) => e);

    const issued = path.join(hangDir, 'commit-issued');
    const deadline = Date.now() + 30_000;
    while (!existsSync(issued) && Date.now() < deadline) {
      await sleep(30);
    }
    expect(existsSync(issued)).toBe(true);
    expect(durable.commitPhase).toBe('commitIssued');
    const backendPid = durable.ownedBackendPid;
    expect(backendPid).toBeTruthy();

    const started = Date.now();
    let cleanupError: unknown;
    try {
      await cleanupLifecycle(state);
    } catch (error) {
      cleanupError = error;
    }
    const elapsed = Date.now() - started;
    // Must finish within bound (settle + short overhead), not hang for full 8s sleep
    expect(elapsed).toBeLessThan(5_000);
    expect(cleanupError).toBeTruthy();
    const cleanupMsg =
      cleanupError instanceof AggregateError
        ? `${cleanupError.message} ${cleanupError.errors.map(String).join(' | ')}`
        : String(cleanupError);
    expect(cleanupMsg).toMatch(
      /terminate failed|fail-closed|journal preserved|forced owned-backend/i,
    );
    // Recovery evidence preserved
    expect(durable.manifest).toBeTruthy();
    expect(durable.ownedBackendPid).toBe(backendPid);
    expect(durable.commitPhase).toBe('ambiguous');
    expect(getActiveSettleTimerCount()).toBe(timersBefore);
    expect(durable.activeSettleTimers).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(baseSig);

    // Explicit authorized cleanup of stuck backend so no residue remains
    delete process.env.E2E_CAS_FORCE_TERMINATE_FAIL;
    try {
      await terminateOwnedSeedBackend(durable);
    } catch {
      // may already be gone after later settlement
    }
    await seedPromise;
    // Digest should still be before (COMMIT aborted or terminated mid-way without full land)
    // If land raced, CAS restore may still be needed — force cleanup with superuser terminate
    const afterFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    if (afterFp !== beforeFp && durable.seed && durable.manifest) {
      const { cleanupEnterpriseAdminSuite } = await import('./seed');
      await cleanupEnterpriseAdminSuite(harness.databaseUrl, durable.seed, durable.manifest).catch(
        () => undefined,
      );
    }
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);

    delete process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS;
    delete process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR;
    rmSync(hangDir, { force: true, recursive: true });
  }, 90_000);

  it('unresponsive TCP terminate endpoint: bounded fail-closed, pending COMMIT stays guarded', async () => {
    const harness = await startCasPostgres();
    cleanups.push(harness.stop);
    const beforeFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    const {
      createDurableRestoreHandle,
      getActiveSettleTimerCount,
      reconcileAmbiguousCommit,
      registerSeedRestoreOnLifecycle,
      seedEnterpriseAdminSuite: seedFn,
      terminateOwnedSeedBackend,
    } = await import('./seed');
    const {
      createLifecycleState,
      createRunToken,
      installLifecycleSignalHandlers,
      cleanupLifecycle,
    } = await import('./lifecycle');

    // Real TCP endpoint: accept connection, never reply (hangs pg client after connect).
    const openSockets = new Set<Socket>();
    let blackhole: Server | undefined;
    const destroyBlackhole = async () => {
      for (const s of openSockets) {
        try {
          s.destroy();
        } catch {
          // ignore
        }
      }
      openSockets.clear();
      if (blackhole) {
        const srv = blackhole;
        blackhole = undefined;
        await new Promise<void>((resolve) => {
          srv.close(() => resolve());
          // Force-close if close waits on half-open clients
          setTimeout(() => resolve(), 500).unref?.();
        });
      }
    };
    const blackholePort = await new Promise<number>((resolve, reject) => {
      const srv = createServer((socket) => {
        openSockets.add(socket);
        socket.on('close', () => openSockets.delete(socket));
        // Accept but never write — connection stays open without PostgreSQL response.
        socket.pause();
      });
      blackhole = srv;
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') resolve(addr.port);
        else reject(new Error('no port'));
      });
    });
    cleanups.push(destroyBlackhole);

    const hangDir = mkdtempSync(path.join(tmpdir(), 'cas-term-tcp-'));
    const durable = createDurableRestoreHandle(harness.databaseUrl);
    const state = createLifecycleState(createRunToken());
    const timersBefore = getActiveSettleTimerCount();
    const baseSig = process.listenerCount('SIGINT');
    const baseTerm = process.listenerCount('SIGTERM');
    installLifecycleSignalHandlers(state);
    // Short settle so cleanup reaches terminate quickly; terminate itself must bound.
    registerSeedRestoreOnLifecycle(state, durable, { settleTimeoutMs: 400 });

    // Tight product terminate bounds for this regression (still production code paths).
    process.env.E2E_CAS_TERMINATE_CONNECT_MS = '200';
    process.env.E2E_CAS_TERMINATE_QUERY_MS = '300';
    process.env.E2E_CAS_TERMINATE_OUTER_MS = '700';
    process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS = '20000';
    process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR = hangDir;
    const seedPromise = seedFn(harness.databaseUrl, durable).catch((e) => e);

    const issued = path.join(hangDir, 'commit-issued');
    const deadline = Date.now() + 30_000;
    while (!existsSync(issued) && Date.now() < deadline) {
      await sleep(30);
    }
    expect(existsSync(issued)).toBe(true);
    expect(durable.commitPhase).toBe('commitIssued');
    expect(durable.commitInFlight).toBeTruthy();
    expect(durable.commitInFlightPending).toBe(true);
    const backendPid = durable.ownedBackendPid;
    expect(backendPid).toBeTruthy();
    const pendingRef = durable.commitInFlight;

    // Point terminate at the blackhole so post-connect query hangs until product bound.
    const blackholeUrl = `postgresql://u:p@127.0.0.1:${blackholePort}/db`;
    const realDbUrl = durable.databaseUrl;
    durable.databaseUrl = blackholeUrl;

    const started = Date.now();
    let cleanupError: unknown;
    try {
      await cleanupLifecycle(state);
    } catch (error) {
      cleanupError = error;
    }
    const elapsed = Date.now() - started;

    // settle(400) + terminate outer(700) + overhead ≪ deferred sleep; must not hang.
    expect(elapsed).toBeLessThan(3_500);
    expect(cleanupError).toBeTruthy();
    const cleanupMsg =
      cleanupError instanceof AggregateError
        ? `${cleanupError.message} ${cleanupError.errors.map(String).join(' | ')}`
        : String(cleanupError);
    expect(cleanupMsg).toMatch(
      /terminate failed|fail-closed|journal preserved|exceeded bound|timeout/i,
    );

    // Restore real URL for authorized residual cleanup only after product assertions.
    durable.databaseUrl = realDbUrl;

    // Pending COMMIT reference/evidence remains guarded — never cleared while pending.
    expect(durable.commitInFlight).toBe(pendingRef);
    expect(durable.commitInFlightPending).toBe(true);
    expect(durable.manifest).toBeTruthy();
    expect(durable.ownedBackendPid).toBe(backendPid);
    expect(durable.commitPhase).toBe('ambiguous');
    // Phase transition to ambiguous must not weaken reconcile guard.
    await expect(reconcileAmbiguousCommit(durable)).rejects.toThrow(
      /cannot reconcile while COMMIT is still in-flight/i,
    );
    expect(getActiveSettleTimerCount()).toBe(timersBefore);
    expect(durable.activeSettleTimers).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(baseSig);
    expect(process.listenerCount('SIGTERM')).toBe(baseTerm);

    // Destroy blackhole sockets so no leftover listeners/handles.
    await destroyBlackhole();

    // Explicit authorized cleanup AFTER all product assertions — must not mask residual state.
    try {
      await terminateOwnedSeedBackend(durable, {
        databaseUrl: realDbUrl,
        outerBoundMs: 3_000,
      });
    } catch {
      // backend may already be in bad state
    }
    await seedPromise;
    const afterFp = digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl));
    if (afterFp !== beforeFp && durable.seed && durable.manifest) {
      const { cleanupEnterpriseAdminSuite } = await import('./seed');
      await cleanupEnterpriseAdminSuite(harness.databaseUrl, durable.seed, durable.manifest).catch(
        () => undefined,
      );
    }
    expect(digestFingerprint(await snapshotGlobalDbDigest(harness.databaseUrl))).toBe(beforeFp);

    delete process.env.E2E_CAS_COMMIT_DEFERRED_SLEEP_MS;
    delete process.env.E2E_CAS_COMMIT_ISSUED_MARKER_DIR;
    delete process.env.E2E_CAS_TERMINATE_CONNECT_MS;
    delete process.env.E2E_CAS_TERMINATE_QUERY_MS;
    delete process.env.E2E_CAS_TERMINATE_OUTER_MS;
    rmSync(hangDir, { force: true, recursive: true });
  }, 90_000);
});
