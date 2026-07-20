#!/usr/bin/env bun
/**
 * Hard gates for enterprise-admin E2E. Missing browser/auth/env is blocked (exit 1), never skipped.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../../..');
const e2eDir = path.resolve(__dirname, '../..');

const fail = (message: string): never => {
  console.error(`[enterprise-admin-e2e] preflight BLOCKED: ${message}`);
  process.exit(1);
};

const ok = (message: string) => console.log(`[enterprise-admin-e2e] preflight ok: ${message}`);

// Docker
try {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
  ok('docker');
} catch {
  if (process.env.E2E_ENTERPRISE_ADMIN_EXTERNAL === '1' || process.env.BASE_URL) {
    ok('docker skipped (external mode)');
  } else {
    fail(
      'Docker is required for isolated PostgreSQL/Redis (or set BASE_URL + DATABASE_URL for external mode)',
    );
  }
}

// Playwright browser
const chromiumHint = path.join(e2eDir, 'node_modules', 'playwright-core');
const rootPlaywright = path.join(root, 'node_modules', 'playwright');
if (
  !existsSync(chromiumHint) &&
  !existsSync(rootPlaywright) &&
  !existsSync(path.join(e2eDir, 'node_modules', 'playwright'))
) {
  fail(
    'Playwright package missing — run: cd e2e && pnpm install && bunx playwright install chromium',
  );
}

const browserCheck = spawnSync('bunx', ['playwright', 'install', '--dry-run', 'chromium'], {
  cwd: e2eDir,
  encoding: 'utf8',
});
// dry-run may not exist on older playwright — fall back to launching a one-shot check
if (browserCheck.status !== 0) {
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `const { chromium } = require('playwright');
       chromium.launch({ headless: true }).then(b => b.close()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });`,
    ],
    { cwd: e2eDir, encoding: 'utf8', env: process.env },
  );
  if (probe.status !== 0) {
    fail(
      `Chromium browser not available (install with: cd e2e && bunx playwright install chromium). detail=${(probe.stderr || probe.stdout || '').slice(0, 300)}`,
    );
  }
}
ok('playwright chromium');

// External mode env
if (process.env.E2E_ENTERPRISE_ADMIN_EXTERNAL === '1' || process.env.BASE_URL) {
  if (!process.env.BASE_URL) fail('BASE_URL required in external mode');
  if (!process.env.DATABASE_URL) fail('DATABASE_URL required in external mode');
  ok('external BASE_URL + DATABASE_URL');
}

ok('all gates passed');
