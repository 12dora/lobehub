#!/usr/bin/env bun
/**
 * Enterprise path boundary CI.
 *
 * Scans tracked source for illegal imports into enterprise modules.
 * Usage: bun run scripts/enterprise/check-path-boundaries.ts
 *        bun run enterprise:check-paths
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS,
  findEnterpriseImportViolations,
  findPackageReverseImportViolations,
  type PathBoundaryViolation,
} from './pathBoundaries';

const ROOT = process.cwd();

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  'tmp',
  'temp',
  '.temp',
  // generated / vendored artifacts
  'out',
  '.turbo',
  'storybook-static',
]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXT.has(path.extname(entry.name))) continue;
    acc.push(full);
  }
  return acc;
}

async function main() {
  const scanRoots = ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS.map((p) => path.join(ROOT, p));

  const files: string[] = [];
  for (const root of scanRoots) {
    try {
      const s = await stat(root);
      if (s.isDirectory()) await walk(root, files);
    } catch {
      // optional root
    }
  }

  const payloads: Array<{ path: string; source: string }> = [];
  for (const absolute of files) {
    const rel = path.relative(ROOT, absolute).replaceAll('\\', '/');
    // Skip generated / heavy vendored trees under packages if any
    if (rel.includes('/node_modules/')) continue;
    if (rel.includes('/dist/') || rel.includes('/build/') || rel.includes('/.next/')) continue;
    const source = await readFile(absolute, 'utf8');
    payloads.push({ path: rel, source });
  }

  const violations: PathBoundaryViolation[] = [
    ...findEnterpriseImportViolations(payloads),
    ...findPackageReverseImportViolations(payloads),
  ];

  if (violations.length === 0) {
    console.log(
      `✅ enterprise path boundaries ok (${payloads.length} files scanned; roots: ${ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS.join(', ')})`,
    );
    process.exit(0);
  }

  console.error('❌ enterprise path boundary violations:\n');
  for (const v of violations) {
    console.error(`- ${v.file}`);
    console.error(`  import: ${v.importSpecifier}`);
    console.error(`  reason: ${v.reason}\n`);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
