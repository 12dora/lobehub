#!/usr/bin/env bun
/**
 * Enterprise path boundary CI.
 *
 * Scans tracked source for illegal imports into enterprise modules.
 * Usage: bun run scripts/enterprise/check-path-boundaries.ts
 *        bun run enterprise:check-paths
 *
 * Fail closed when mandatory scan roots are missing/unreadable or when
 * zero source files were scanned (wrong CWD / empty roots).
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read scan directory ${dir}: ${message}`, { cause: error });
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
  // Require a recognizable monorepo root so wrong-CWD cannot silently pass.
  try {
    await stat(path.join(ROOT, 'package.json'));
    await stat(path.join(ROOT, 'scripts', 'enterprise'));
  } catch {
    console.error(
      `❌ enterprise path boundaries: not a repository root (cwd=${ROOT}). Run from monorepo root.`,
    );
    process.exit(2);
  }

  const rootCoverage: Array<{ files: number; root: string; status: 'ok' | 'missing' }> = [];
  const files: string[] = [];

  for (const relativeRoot of ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS) {
    const absoluteRoot = path.join(ROOT, relativeRoot);
    try {
      const s = await stat(absoluteRoot);
      if (!s.isDirectory()) {
        console.error(
          `❌ enterprise path boundaries: scan root is not a directory: ${relativeRoot}`,
        );
        process.exit(2);
      }
      const before = files.length;
      await walk(absoluteRoot, files);
      rootCoverage.push({ files: files.length - before, root: relativeRoot, status: 'ok' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `❌ enterprise path boundaries: mandatory scan root missing or unreadable: ${relativeRoot} (${message})`,
      );
      process.exit(2);
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

  if (payloads.length === 0) {
    console.error(
      `❌ enterprise path boundaries: zero files scanned under roots [${ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS.join(', ')}]. Refuse empty coverage.`,
    );
    process.exit(2);
  }

  const violations: PathBoundaryViolation[] = [
    ...findEnterpriseImportViolations(payloads),
    ...findPackageReverseImportViolations(payloads),
  ];

  if (violations.length === 0) {
    const coverage = rootCoverage.map((c) => `${c.root}:${c.files}`).join(', ');
    console.log(
      `✅ enterprise path boundaries ok (${payloads.length} files scanned; roots: ${coverage})`,
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
