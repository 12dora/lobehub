import { isUtf8 } from 'node:buffer';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
  BrandingAllowedLiteral,
  BrandingBaseline,
  BrandingLiteralCandidate,
} from './brandingLiterals';
import {
  BRANDING_BINARY_EXTENSIONS,
  BRANDING_DIRECTORY_ROOTS,
  BRANDING_ROOT_HTML_FILES,
  brandingOccurrenceKey,
  createBrandingBaseline,
  isExcludedBrandingPath,
  isExplicitTextFile,
  MAX_BRANDING_BINARY_FILE_BYTES,
  MAX_BRANDING_TEXT_FILE_BYTES,
  normalizeRepositoryPath,
  scanBrandingFile,
  validateBrandingBaseline,
} from './brandingLiterals';

export interface BrandingScanViolation extends BrandingLiteralCandidate {
  reason: 'baseline-occurrence-missing' | 'new-user-visible-literal';
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
  kind: 'binary' | 'text';
  path: string;
}

const isInsideRoot = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

const hasPrefix = (content: Uint8Array, prefix: number[]): boolean =>
  prefix.every((byte, index) => content[index] === byte);

export const hasValidBinarySignature = (extension: string, content: Uint8Array): boolean => {
  const ascii = (start: number, end: number) =>
    Buffer.from(content.slice(start, end)).toString('ascii');
  switch (extension) {
    case '.7z': {
      return hasPrefix(content, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
    }
    case '.a': {
      return ascii(0, 8) === '!<arch>\n';
    }
    case '.avif': {
      return ascii(4, 8) === 'ftyp' && ascii(8, 32).includes('avif');
    }
    case '.bmp': {
      return ascii(0, 2) === 'BM';
    }
    case '.dmg': {
      return ascii(Math.max(0, content.length - 512), content.length).includes('koly');
    }
    case '.gif': {
      return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
    }
    case '.gz': {
      return hasPrefix(content, [0x1f, 0x8b]);
    }
    case '.ico': {
      return hasPrefix(content, [0, 0, 1, 0]);
    }
    case '.icns': {
      return ascii(0, 4) === 'icns';
    }
    case '.jar':
    case '.zip': {
      return ascii(0, 2) === 'PK';
    }
    case '.jpeg':
    case '.jpg': {
      return hasPrefix(content, [0xff, 0xd8, 0xff]);
    }
    case '.mov':
    case '.mp4': {
      return ascii(4, 8) === 'ftyp';
    }
    case '.mp3': {
      return ascii(0, 3) === 'ID3' || (content[0] === 0xff && (content[1] ?? 0) >= 0xe0);
    }
    case '.otf': {
      return ascii(0, 4) === 'OTTO';
    }
    case '.pdf': {
      return ascii(0, 5) === '%PDF-';
    }
    case '.png': {
      return hasPrefix(content, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
    case '.so': {
      return (
        hasPrefix(content, [0x7f, 0x45, 0x4c, 0x46]) || hasPrefix(content, [0xcf, 0xfa, 0xed, 0xfe])
      );
    }
    case '.tar': {
      return ascii(257, 262) === 'ustar';
    }
    case '.ttf': {
      return hasPrefix(content, [0, 1, 0, 0]);
    }
    case '.webm': {
      return hasPrefix(content, [0x1a, 0x45, 0xdf, 0xa3]);
    }
    case '.webp': {
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    }
    case '.woff': {
      return ascii(0, 4) === 'wOFF';
    }
    case '.woff2': {
      return ascii(0, 4) === 'wOF2';
    }
    default: {
      return false;
    }
  }
};

const collectFiles = async (
  root: string,
): Promise<{ errors: string[]; files: CollectedFile[]; skippedFiles: number }> => {
  const files: CollectedFile[] = [];
  const errors: string[] = [];
  let skippedFiles = 0;

  const addFile = (relativePath: string) => {
    if (isExcludedBrandingPath(relativePath)) {
      skippedFiles += 1;
      return;
    }
    const extension = path.posix.extname(relativePath).toLowerCase();
    if (BRANDING_BINARY_EXTENSIONS.has(extension)) {
      files.push({ kind: 'binary', path: relativePath });
      return;
    }
    if (isExplicitTextFile(relativePath)) {
      files.push({ kind: 'text', path: relativePath });
      return;
    }
    errors.push(`${relativePath}: unclassified file extension in branding runtime root`);
  };

  const walk = async (directory: string, publicHtmlOnly = false) => {
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
        if (!isExcludedBrandingPath(`${relativePath}/placeholder.ts`)) {
          await walk(absolutePath, publicHtmlOnly);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (publicHtmlOnly && path.extname(entry.name).toLowerCase() !== '.html') continue;
      addFile(relativePath);
    }
  };

  const requireDirectory = async (relativePath: string, publicHtmlOnly = false) => {
    const absolutePath = path.join(root, relativePath);
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        errors.push(`${relativePath}: required branding scan root must be a real directory`);
        return;
      }
      await walk(absolutePath, publicHtmlOnly);
    } catch (error) {
      errors.push(`${relativePath}: ${(error as Error).message}`);
    }
  };

  for (const scanRoot of BRANDING_DIRECTORY_ROOTS) await requireDirectory(scanRoot);
  await requireDirectory('public', true);

  for (const rootFile of BRANDING_ROOT_HTML_FILES) {
    try {
      const info = await lstat(path.join(root, rootFile));
      if (info.isSymbolicLink() || !info.isFile()) {
        errors.push(`${rootFile}: required runtime HTML target must be a regular file`);
      } else addFile(rootFile);
    } catch (error) {
      errors.push(`${rootFile}: ${(error as Error).message}`);
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  return { errors, files, skippedFiles };
};

const applyBaseline = (
  candidates: BrandingLiteralCandidate[],
  baseline: BrandingBaseline,
): BrandingScanViolation[] => {
  const violations: BrandingScanViolation[] = [];
  const candidateGroups = new Map<string, BrandingLiteralCandidate[]>();
  for (const candidate of candidates) {
    const key = brandingOccurrenceKey(candidate);
    const group = candidateGroups.get(key) ?? [];
    group.push(candidate);
    candidateGroups.set(key, group);
  }

  const baselineCounts = new Map<string, number>();
  for (const entry of baseline.entries) {
    const key = brandingOccurrenceKey(entry);
    baselineCounts.set(key, entry.count);
    const actual = candidateGroups.get(key)?.length ?? 0;
    for (let index = actual; index < entry.count; index += 1) {
      violations.push({
        brand: entry.brand,
        column: 1,
        fingerprint: entry.fingerprint,
        line: 1,
        locator: entry.locator,
        path: entry.path,
        preview: entry.preview,
        reason: 'baseline-occurrence-missing',
      });
    }
  }
  for (const [key, group] of candidateGroups) {
    const expected = baselineCounts.get(key) ?? 0;
    for (const candidate of group.slice(expected)) {
      violations.push({ ...candidate, reason: 'new-user-visible-literal' });
    }
  }
  return violations.sort(
    (left, right) =>
      left.path.localeCompare(right.path, 'en') ||
      left.locator.localeCompare(right.locator, 'en') ||
      left.line - right.line ||
      left.column - right.column,
  );
};

const resolveRegularFile = async (root: string, relativePath: string): Promise<string> => {
  const absolutePath = path.resolve(root, relativePath);
  if (!isInsideRoot(root, absolutePath)) throw new Error(`${relativePath}: resolved outside root`);
  const info = await lstat(absolutePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${relativePath}: scan target must be a regular non-symlink file`);
  }
  const canonicalPath = await realpath(absolutePath);
  if (!isInsideRoot(root, canonicalPath))
    throw new Error(`${relativePath}: canonical path escaped root`);
  return canonicalPath;
};

export const scanBrandingRepository = async ({
  baseline,
  root,
}: BrandingRepositoryScanOptions): Promise<BrandingRepositoryScanResult> => {
  const errors = validateBrandingBaseline(baseline);
  let canonicalRoot: string;
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error('repository root must be a real directory, not a symlink');
    }
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

  const collected = await collectFiles(canonicalRoot);
  errors.push(...collected.errors);
  const allowed: BrandingAllowedLiteral[] = [];
  const candidates: BrandingLiteralCandidate[] = [];
  let filesScanned = 0;
  let skippedFiles = collected.skippedFiles;

  for (const file of collected.files) {
    try {
      const absolutePath = await resolveRegularFile(canonicalRoot, file.path);
      const fileStat = await stat(absolutePath);
      if (file.kind === 'binary' && fileStat.size > MAX_BRANDING_BINARY_FILE_BYTES) {
        errors.push(
          `${file.path}: binary validation target exceeds ${MAX_BRANDING_BINARY_FILE_BYTES} byte limit`,
        );
        continue;
      }
      if (file.kind === 'text' && fileStat.size > MAX_BRANDING_TEXT_FILE_BYTES) {
        errors.push(
          `${file.path}: text scan target exceeds ${MAX_BRANDING_TEXT_FILE_BYTES} byte limit`,
        );
        continue;
      }
      const content = await readFile(absolutePath);
      if (file.kind === 'binary') {
        const extension = path.extname(file.path).toLowerCase();
        if (!hasValidBinarySignature(extension, content)) {
          errors.push(`${file.path}: invalid ${extension} binary signature`);
        } else skippedFiles += 1;
        continue;
      }
      if (!isUtf8(content)) {
        errors.push(`${file.path}: invalid UTF-8 in a text scan target`);
        continue;
      }
      filesScanned += 1;
      const result = scanBrandingFile(file.path, content.toString('utf8'));
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
    filesScanned,
    skippedFiles,
    violations: applyBaseline(candidates, baseline),
  };
};
