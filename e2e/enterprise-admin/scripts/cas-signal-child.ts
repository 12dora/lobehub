#!/usr/bin/env bun
/**
 * Independent CAS restore child for real SIGINT/SIGTERM coverage.
 * Env:
 *   CAS_DATABASE_URL — postgres URL
 *   CAS_READY_FILE — written when seed fully armed (optional; post-commit tests use barrier)
 *   CAS_BEFORE_FP_FILE — written with before digest fingerprint
 *   E2E_CAS_POST_COMMIT_BARRIER_DIR — if set, seed pauses after COMMIT before arm;
 *     child writes post-commit marker there for parent to signal pre-ready.
 */
import { writeFileSync } from 'node:fs';

import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  installLifecycleSignalHandlers,
} from '../support/lifecycle';
import {
  createDurableRestoreHandle,
  digestFingerprint,
  registerSeedRestoreOnLifecycle,
  seedEnterpriseAdminSuite,
  snapshotGlobalDbDigest,
} from '../support/seed';

const databaseUrl = process.env.CAS_DATABASE_URL;
const readyFile = process.env.CAS_READY_FILE;
const beforeFpFile = process.env.CAS_BEFORE_FP_FILE;

if (!databaseUrl || !beforeFpFile) {
  console.error('missing CAS_DATABASE_URL or CAS_BEFORE_FP_FILE');
  process.exit(2);
}

const runToken = createRunToken();
const state = createLifecycleState(runToken);
installLifecycleSignalHandlers(state);

const durable = createDurableRestoreHandle(databaseUrl);
registerSeedRestoreOnLifecycle(state, durable);

const main = async () => {
  const before = await snapshotGlobalDbDigest(databaseUrl);
  writeFileSync(beforeFpFile, digestFingerprint(before), 'utf8');

  await seedEnterpriseAdminSuite(databaseUrl, durable);

  if (readyFile) {
    writeFileSync(readyFile, 'ready', 'utf8');
  }

  // Stay alive until parent signals.
  setInterval(() => {}, 60_000);
};

main().catch(async (error) => {
  console.error(error);
  durable.markSettled();
  await cleanupLifecycle(state).catch(() => undefined);
  process.exit(1);
});
