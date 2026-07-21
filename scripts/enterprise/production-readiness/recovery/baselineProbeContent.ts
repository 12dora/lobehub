/**
 * Allowlisted baseline DB-compat probe source text.
 * Planted into the materialized baseline tree after archive verification.
 * Must require DATABASE_URL and perform real legacy SELECTs; package version alone never passes.
 */
import { createHash } from 'node:crypto';

export const ALLOWLISTED_BASELINE_PROBE_RELATIVE_PATH =
  'scripts/__q06_allowlisted_baseline_db_compat.mjs' as const;

/**
 * Probe planted only into materialization. It:
 * 1. Reads package.json from cwd (baseline root)
 * 2. Requires DATABASE_URL
 * 3. SELECTs legacy baseline tables that must remain on upgraded DB
 * 4. Confirms enterprise tables still exist (expand-only retention)
 */
export const ALLOWLISTED_BASELINE_PROBE_SOURCE = `#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const BASELINE_VERSION = '2.2.10';
const LEGACY_TABLES = ['users', 'sessions', 'agents', 'topics', 'messages', 'user_settings', 'api_keys'];
const ENTERPRISE_PREFIX = 'platform_';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || databaseUrl.length < 8) {
  process.stderr.write(JSON.stringify({ error: 'missing-database-url' }) + '\\n');
  process.exit(2);
}

const root = process.cwd();
const packageRaw = await readFile(path.join(root, 'package.json'), 'utf8');
const pkg = JSON.parse(packageRaw);
const packageVersionOk = pkg.version === BASELINE_VERSION;
const packageJsonSha256 = createHash('sha256').update(packageRaw).digest('hex');

const schemaDir = path.join(root, 'packages/database/src/schemas');
let schemaTableCount = 0;
try {
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
        const text = await readFile(p, 'utf8');
        const re = /pgTable\\(\\s*['"]([a-z][a-z0-9_]*)['"]/gs;
        let m;
        while ((m = re.exec(text)) !== null) schemaTableCount += 1;
      }
    }
  };
  await walk(schemaDir);
} catch {
  schemaTableCount = 0;
}

let legacyReadOk = false;
let enterpriseRetainedOk = false;
let legacyHits = 0;
let enterpriseHits = 0;

try {
  // Never resolve workspace deps from baseline package.json (partial materialization).
  // Host require root is the full current checkout used only for the pg client package.
  const hostRoot = process.env.Q06_HOST_REQUIRE_ROOT || process.cwd();
  const pg = createRequire(path.join(hostRoot, 'package.json'))('pg');
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 8000 });
  await client.connect();
  try {
    for (const table of LEGACY_TABLES) {
      const r = await client.query(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS exists",
        [table],
      );
      if (r.rows[0]?.exists) {
        await client.query('SELECT 1 FROM "' + table + '" LIMIT 1');
        legacyHits += 1;
      }
    }
    legacyReadOk = legacyHits === LEGACY_TABLES.length;

    const ent = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE $1",
      [ENTERPRISE_PREFIX + '%'],
    );
    enterpriseHits = ent.rows.length;
    enterpriseRetainedOk = enterpriseHits >= 1;
  } finally {
    await client.end();
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify({ error: 'db-probe-failed', class: error && error.name ? error.name : 'Error' }) + '\\n',
  );
  process.exit(1);
}

const ok = packageVersionOk && legacyReadOk && enterpriseRetainedOk;
process.stdout.write(
  JSON.stringify({
    packageVersionOk,
    packageJsonSha256,
    schemaTableCount,
    legacyReadOk,
    legacyHits,
    enterpriseRetainedOk,
    enterpriseHits,
    baselineVersion: pkg.version,
  }) + '\\n',
);
process.exit(ok ? 0 : 1);
`;

export const ALLOWLISTED_BASELINE_PROBE_SHA256 = createHash('sha256')
  .update(ALLOWLISTED_BASELINE_PROBE_SOURCE)
  .digest('hex');
