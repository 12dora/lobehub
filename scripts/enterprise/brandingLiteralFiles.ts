import { isUtf8 } from 'node:buffer';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  BrandingAllowedLiteral,
  BrandingBaseline,
  BrandingLiteralCandidate,
} from './brandingLiterals';
import {
  BRANDING_BINARY_EXTENSIONS,
  BRANDING_SCAN_ROOTS,
  BRANDING_TEXT_EXTENSIONS,
  createBrandingBaseline,
  isExcludedBrandingPath,
  normalizeRepositoryPath,
  scanBrandingFile,
  validateBrandingBaseline,
} from './brandingLiterals';

export interface BrandingScanViolation extends BrandingLiteralCandidate {
  reason: 'baseline-count-decreased' | 'new-user-visible-literal';
}

export interface BrandingRepositoryScanResult {
  allowed: BrandingAllowedLiteral[];
  baseline: BrandingBaseline;
  candidates: BrandingLiteralCandidate[];
  errors: string[];
  filesScanned: number;
  skippedFiles: number;
  violations: BrandingScanViolation[];
}

interface BrandingRepositoryScanOptions {
  baseline: BrandingBaseline;
  root: string;
}

interface CollectedFile {
  path: string;
  supportedExtension: boolean;
}

const isInsideRoot = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

const collectFiles = async (
  root: string,
): Promise<{ errors: string[]; files: CollectedFile[]; skippedFiles: number }> => {
  const files: CollectedFile[] = [];
  const errors: string[] = [];
  let skippedFiles = 0;

  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRepositoryPath(path.relative(root, absolutePath));

      if (entry.isSymbolicLink()) {
        errors.push(`${relativePath}: symbolic links are not valid branding scan targets`);
        continue;
      }
      if (entry.isDirectory()) {
        if (!isExcludedBrandingPath(`${relativePath}/placeholder.ts`)) await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isExcludedBrandingPath(relativePath)) {
        skippedFiles += 1;
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (BRANDING_BINARY_EXTENSIONS.has(extension)) {
        skippedFiles += 1;
        continue;
      }
      files.push({
        path: relativePath,
        supportedExtension: BRANDING_TEXT_EXTENSIONS.has(extension),
      });
    }
  };

  for (const scanRoot of BRANDING_SCAN_ROOTS) {
    const absoluteRoot = path.join(root, scanRoot);
    try {
      const rootStat = await stat(absoluteRoot);
      if (!rootStat.isDirectory()) {
        errors.push(`${scanRoot}: branding scan root is not a directory`);
        continue;
      }
      await walk(absoluteRoot);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      errors.push(
        nodeError.code === 'ENOENT'
          ? `${scanRoot}: required branding scan root is missing`
          : `${scanRoot}: ${nodeError.message}`,
      );
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { errors, files, skippedFiles };
};

const getCounts = (candidates: BrandingLiteralCandidate[]) => {
  const counts = new Map<string, { LobeChat: number; LobeHub: number }>();
  for (const candidate of candidates) {
    const current = counts.get(candidate.path) ?? { LobeChat: 0, LobeHub: 0 };
    current[candidate.brand] += 1;
    counts.set(candidate.path, current);
  }
  return counts;
};

const applyBaseline = (
  candidates: BrandingLiteralCandidate[],
  baseline: BrandingBaseline,
): BrandingScanViolation[] => {
  const violations: BrandingScanViolation[] = [];
  const counts = getCounts(candidates);
  const candidatesByKey = new Map<string, BrandingLiteralCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.path}\0${candidate.brand}`;
    const matches = candidatesByKey.get(key) ?? [];
    matches.push(candidate);
    candidatesByKey.set(key, matches);
  }

  const baselineCounts = new Map<string, number>();
  for (const entry of baseline.entries) {
    for (const brand of ['LobeChat', 'LobeHub'] as const) {
      const expected = entry[brand] ?? 0;
      if (expected > 0) baselineCounts.set(`${entry.path}\0${brand}`, expected);
      const actual = counts.get(entry.path)?.[brand] ?? 0;
      if (actual < expected) {
        violations.push({
          brand,
          column: 1,
          line: 1,
          path: entry.path,
          preview: `baseline expects ${expected}, repository contains ${actual}`,
          reason: 'baseline-count-decreased',
        });
      }
    }
  }

  for (const [key, matches] of candidatesByKey) {
    const expected = baselineCounts.get(key) ?? 0;
    for (const candidate of matches.slice(expected)) {
      violations.push({ ...candidate, reason: 'new-user-visible-literal' });
    }
  }

  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path, 'en') ||
      left.line - right.line ||
      left.column - right.column ||
      left.brand.localeCompare(right.brand, 'en'),
  );
};

export const scanBrandingRepository = async ({
  baseline,
  root,
}: BrandingRepositoryScanOptions): Promise<BrandingRepositoryScanResult> => {
  const errors = validateBrandingBaseline(baseline);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    return {
      allowed: [],
      baseline,
      candidates: [],
      errors: [...errors, `invalid repository root: ${(error as Error).message}`],
      filesScanned: 0,
      skippedFiles: 0,
      violations: [],
    };
  }

  if (!path.isAbsolute(canonicalRoot))
    errors.push('repository root must resolve to an absolute path');
  const collected = await collectFiles(canonicalRoot);
  errors.push(...collected.errors);
  const allowed: BrandingAllowedLiteral[] = [];
  const candidates: BrandingLiteralCandidate[] = [];

  for (const file of collected.files) {
    const absolutePath = path.resolve(canonicalRoot, file.path);
    if (!isInsideRoot(canonicalRoot, absolutePath)) {
      errors.push(`${file.path}: resolved outside repository root`);
      continue;
    }
    try {
      const content = await readFile(absolutePath);
      if (!isUtf8(content)) {
        errors.push(`${file.path}: invalid UTF-8 in a non-binary scan target`);
        continue;
      }
      const source = content.toString('utf8');
      const result = scanBrandingFile(file.path, source, {
        supportedExtension: file.supportedExtension,
      });
      allowed.push(...result.allowed);
      candidates.push(...result.candidates);
      errors.push(...result.errors);
    } catch (error) {
      errors.push(`${file.path}: ${(error as Error).message}`);
    }
  }

  return {
    allowed,
    baseline: createBrandingBaseline(candidates),
    candidates,
    errors: [...new Set(errors)].sort((left, right) => left.localeCompare(right, 'en')),
    filesScanned: collected.files.length,
    skippedFiles: collected.skippedFiles,
    violations: applyBaseline(candidates, baseline),
  };
};
