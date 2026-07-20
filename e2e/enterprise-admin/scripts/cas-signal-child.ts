#!/usr/bin/env bun
/**
 * Independent CAS restore child for real SIGINT/SIGTERM coverage.
 * Env:
 *   CAS_DATABASE_URL — postgres URL
 *   CAS_READY_FILE — written when seed committed and handlers armed
 *   CAS_BEFORE_FP_FILE — written with before digest fingerprint
 *   CAS_RESULT_FILE — written after restore with after fingerprint
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
const resultFile = process.env.CAS_RESULT_FILE;

if (!databaseUrl || !readyFile || !beforeFpFile || !resultFile) {
  console.error('missing CAS_* env');
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
  writeFileSync(readyFile, 'ready', 'utf8');

  // Stay alive until parent signals.
  setInterval(() => {}, 60_000);
};

main().catch(async (error) => {
  console.error(error);
  await cleanupLifecycle(state).catch(() => undefined);
  process.exit(1);
});

// On graceful path (should not reach), write result
process.on('exit', () => {
  // best-effort: parent also snapshots
});
