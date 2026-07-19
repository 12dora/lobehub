#!/usr/bin/env bun
/**
 * Runtime-branding literal CI guard.
 *
 * Usage: bun run enterprise:check-branding
 * Baseline refresh (review the diff): bun run enterprise:check-branding --update-baseline
 */
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { BrandingRepositoryScanResult } from './brandingLiteralFiles';
import { scanBrandingRepository } from './brandingLiteralFiles';
import type { BrandingBaseline } from './brandingLiterals';
import { normalizeRepositoryPath } from './brandingLiterals';

const DEFAULT_BASELINE_PATH = 'scripts/enterprise/branding-literals-baseline.json';

interface CliOptions {
  baselinePath: string;
  root: string;
  updateBaseline: boolean;
}

export const parseBrandingScanArgs = (args: string[], cwd: string): CliOptions => {
  let root = cwd;
  let baselinePath = DEFAULT_BASELINE_PATH;
  let updateBaseline = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--update-baseline') {
      updateBaseline = true;
      continue;
    }
    if (argument === '--root' || argument === '--baseline') {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === '--root') root = path.resolve(cwd, value);
      else baselinePath = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return { baselinePath, root, updateBaseline };
};

const resolveInsideRoot = async (root: string, target: string): Promise<string> => {
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('repository root must be a real directory, not a symlink');
  }
  const canonicalRoot = await realpath(root);
  const safeTarget = normalizeRepositoryPath(target);
  const absoluteTarget = path.resolve(canonicalRoot, safeTarget);
  const relative = path.relative(canonicalRoot, absoluteTarget);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`baseline must stay inside repository root: ${target}`);
  }
  const targetInfo = await lstat(absoluteTarget);
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    throw new Error(`baseline must be a regular non-symlink file: ${target}`);
  }
  const canonicalTarget = await realpath(absoluteTarget);
  const canonicalRelative = path.relative(canonicalRoot, canonicalTarget);
  if (
    canonicalRelative === '..' ||
    canonicalRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(canonicalRelative)
  ) {
    throw new Error(`baseline canonical path must stay inside repository root: ${target}`);
  }
  return canonicalTarget;
};

const readBaseline = async (baselinePath: string): Promise<BrandingBaseline> => {
  const source = await readFile(baselinePath, 'utf8');
  return JSON.parse(source) as BrandingBaseline;
};

export const serializeBrandingBaseline = (baseline: BrandingBaseline): string =>
  [
    '{',
    '  "entries": [',
    baseline.entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n'),
    '  ],',
    `  "policy": ${JSON.stringify(baseline.policy)},`,
    `  "version": ${baseline.version}`,
    '}',
    '',
  ].join('\n');

const atomicWriteBaseline = async (baselinePath: string, baseline: BrandingBaseline) => {
  const temporaryPath = path.join(
    path.dirname(baselinePath),
    `.${path.basename(baselinePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o644);
    await handle.writeFile(serializeBrandingBaseline(baseline), 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    const targetInfo = await lstat(baselinePath);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
      throw new Error('baseline changed type before atomic replacement');
    }
    await rename(temporaryPath, baselinePath);
  } catch (error) {
    if (handle) await handle.close();
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      const nodeError = cleanupError as NodeJS.ErrnoException;
      if (nodeError.code !== 'ENOENT')
        console.error('Failed to clean branding baseline temp file', cleanupError);
    }
    throw error;
  }
};

export const formatBrandingScanResult = (result: BrandingRepositoryScanResult): string => {
  if (result.errors.length > 0) {
    return [
      '❌ branding literal scan configuration errors:',
      ...result.errors.map((error) => `- ${error}`),
    ].join('\n');
  }
  if (result.violations.length > 0) {
    return [
      '❌ unclassified runtime-branding literals:',
      ...result.violations.map(
        (violation) =>
          `- ${violation.path}:${violation.line}:${violation.column} [${violation.brand}] ${violation.reason}\n  locator: ${violation.locator}\n  ${violation.preview}`,
      ),
      '',
      'Use runtime branding/i18n, classify a stable internal identifier in code, or update the reviewed baseline.',
    ].join('\n');
  }
  const allowedCategories = new Map<string, number>();
  for (const occurrence of result.allowed) {
    allowedCategories.set(
      occurrence.category,
      (allowedCategories.get(occurrence.category) ?? 0) + 1,
    );
  }
  const allowedSummary = [...allowedCategories.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([category, count]) => `${category}=${count}`)
    .join(', ');
  return `✅ runtime branding literals ok (${result.filesScanned} files scanned, ${result.candidates.length} baselined, ${result.allowed.length} stable semantic occurrences${allowedSummary ? `: ${allowedSummary}` : ''})`;
};

export const runBrandingScanCli = async (
  args: string[],
  cwd = process.cwd(),
): Promise<{ code: 0 | 1 | 2; output: string }> => {
  try {
    const options = parseBrandingScanArgs(args, cwd);
    const baselinePath = await resolveInsideRoot(options.root, options.baselinePath);
    const baseline = await readBaseline(baselinePath);
    const result = await scanBrandingRepository({ baseline, root: options.root });

    if (result.errors.length > 0) return { code: 2, output: formatBrandingScanResult(result) };
    if (options.updateBaseline) {
      await atomicWriteBaseline(baselinePath, result.baseline);
      return {
        code: 0,
        output: `✅ updated branding baseline (${result.baseline.entries.length} occurrence identities, ${result.candidates.length} literals); review the diff`,
      };
    }
    return {
      code: result.violations.length > 0 ? 1 : 0,
      output: formatBrandingScanResult(result),
    };
  } catch (error) {
    return { code: 2, output: `❌ branding literal scan failed: ${(error as Error).message}` };
  }
};

if (import.meta.main) {
  const result = await runBrandingScanCli(process.argv.slice(2));
  const log = result.code === 0 ? console.log : console.error;
  log(result.output);
  process.exitCode = result.code;
}
