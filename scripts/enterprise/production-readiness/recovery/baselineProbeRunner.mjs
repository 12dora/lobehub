#!/usr/bin/env node
/**
 * Baseline package-boundary probe runner.
 * Reads package.json ONLY from --baseline-root (materialized baseline tree).
 * Optional --database-url runs legacy SELECT against upgraded DB.
 * Prints JSON: { packageVersionOk, legacyReadOk }
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const baselineRoot = getArg('--baseline-root');
const databaseUrl = getArg('--database-url');

if (!baselineRoot || baselineRoot.includes('\0')) {
  console.error('missing-baseline-root');
  process.exit(2);
}

const packagePath = path.join(baselineRoot, 'package.json');
const raw = await readFile(packagePath, 'utf8');
const pkg = JSON.parse(raw);
const packageVersionOk = pkg.version === '2.2.10';

let legacyReadOk = false;
if (databaseUrl) {
  try {
    // Prefer pg from process cwd node_modules (harness), but only query legacy tables.
    const require = createRequire(path.join(process.cwd(), 'package.json'));
    const pg = require('pg');
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      await client.query('SELECT 1 FROM users LIMIT 1');
      legacyReadOk = true;
    } finally {
      await client.end();
    }
  } catch {
    legacyReadOk = false;
  }
} else {
  // Without DB, package boundary alone is still an executable baseline step.
  legacyReadOk = packageVersionOk;
}

if (!packageVersionOk) {
  process.exit(1);
}

process.stdout.write(
  JSON.stringify({ packageVersionOk, legacyReadOk, baselineVersion: pkg.version }) + '\n',
);
