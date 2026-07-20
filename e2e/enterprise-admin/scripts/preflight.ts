#!/usr/bin/env bun
/**
 * Hard gates for enterprise-admin E2E. Missing browser/auth/env is blocked (exit 1), never skipped.
 * Chromium must actually launch and close — dry-run alone is insufficient.
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

// Docker — only required for isolated mode
const external =
  process.env.E2E_ENTERPRISE_ADMIN_EXTERNAL === '1' &&
  process.env.E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB === '1';

try {
  execFileSync('docker', ['info'], { stdio: 'ignore' });
  ok('docker');
} catch {
  if (external) {
    ok('docker skipped (explicit external disposable mode)');
  } else {
    fail(
      'Docker is required for isolated PostgreSQL/Redis (or set E2E_ENTERPRISE_ADMIN_EXTERNAL=1 and E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB=1)',
    );
  }
}

// Playwright package present
const hasPlaywright =
  existsSync(path.join(e2eDir, 'node_modules', 'playwright')) ||
  existsSync(path.join(root, 'node_modules', 'playwright')) ||
  existsSync(path.join(e2eDir, 'node_modules', 'playwright-core'));
if (!hasPlaywright) {
  fail(
    'Playwright package missing — run: cd e2e && pnpm install && bunx playwright install chromium',
  );
}

// Always launch and close Chromium — never trust install --dry-run alone.
const probe = spawnSync(
  process.execPath,
  [
    '-e',
    `const { chromium } = require('playwright');
     chromium.launch({ headless: true })
       .then(async (b) => { await b.newPage(); await b.close(); process.exit(0); })
       .catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });`,
  ],
  {
    cwd: e2eDir,
    encoding: 'utf8',
    env: process.env,
    timeout: 60_000,
  },
);
if (probe.status !== 0) {
  fail(
    `Chromium browser not available (install with: cd e2e && bunx playwright install chromium). detail=${(probe.stderr || probe.stdout || '').slice(0, 400)}`,
  );
}
ok('playwright chromium launch');

if (process.env.E2E_ENTERPRISE_ADMIN_EXTERNAL === '1') {
  if (process.env.E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB !== '1') {
    fail(
      'external mode requires E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB=1 (refuses shared DB mutation)',
    );
  }
  if (!process.env.BASE_URL) fail('BASE_URL required in external mode');
  if (!process.env.DATABASE_URL) fail('DATABASE_URL required in external mode');
  ok('external disposable BASE_URL + DATABASE_URL');
}

ok('all gates passed');
