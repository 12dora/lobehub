import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  BASELINE_COMMIT,
  BASELINE_LAST_TAG,
  BASELINE_MIGRATION_COUNT,
  BASELINE_MIGRATION_LAST_IDX,
  BASELINE_VERSION,
  JOURNAL_RELATIVE_PATH,
  MIGRATIONS_DIR,
} from './constants';

export interface JournalEntry {
  idx: number;
  tag: string;
  /** Drizzle journal `when` — used as folderMillis / created_at. */
  when: number;
}

export interface JournalFile {
  entries: JournalEntry[];
}

export interface BaselineVerification {
  baselineCommit: typeof BASELINE_COMMIT;
  baselineVersion: typeof BASELINE_VERSION;
  fileMatchCount: number;
  lastTag: string;
  match: 'failed' | 'passed';
  migrationCount: number;
  reasons: string[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const gitShowText = (commit: string, relativePath: string, repoRoot: string): string | null => {
  try {
    return execFileSync('git', ['show', `${commit}:${relativePath}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch {
    return null;
  }
};

/** True when path is a baseline-range SQL or snapshot (0000–0116). */
export const isBaselineMigrationPath = (relativePath: string): boolean => {
  const normalized = relativePath.replaceAll('\\', '/');
  const sqlMatch = normalized.match(new RegExp(`^${MIGRATIONS_DIR}/(\\d{4})_[^/]+\\.sql$`));
  if (sqlMatch) {
    const idx = Number(sqlMatch[1]);
    return Number.isInteger(idx) && idx >= 0 && idx <= BASELINE_MIGRATION_LAST_IDX;
  }
  const snapshotMatch = normalized.match(
    new RegExp(`^${MIGRATIONS_DIR}/meta/(\\d{4})_snapshot\\.json$`),
  );
  if (!snapshotMatch) return false;
  const idx = Number(snapshotMatch[1]);
  return Number.isInteger(idx) && idx >= 0 && idx <= BASELINE_MIGRATION_LAST_IDX;
};

export const loadJournal = (repoRoot: string): JournalFile =>
  readJson<JournalFile>(path.join(repoRoot, JOURNAL_RELATIVE_PATH));

export const listBaselineMigrationFiles = (repoRoot: string): string[] => {
  const migrationsRoot = path.join(repoRoot, MIGRATIONS_DIR);
  const metaRoot = path.join(migrationsRoot, 'meta');
  const files: string[] = [];

  for (let idx = 0; idx <= BASELINE_MIGRATION_LAST_IDX; idx += 1) {
    const prefix = String(idx).padStart(4, '0');
    const sqlMatches = readdirSync(migrationsRoot).filter(
      (name) => name.startsWith(`${prefix}_`) && name.endsWith('.sql'),
    );
    for (const name of sqlMatches) {
      files.push(path.join(MIGRATIONS_DIR, name));
    }
    const snapshot = `${prefix}_snapshot.json`;
    if (existsSync(path.join(metaRoot, snapshot))) {
      files.push(path.join(MIGRATIONS_DIR, 'meta', snapshot));
    }
  }

  return files.toSorted();
};

export const verifyBaselinePackageVersion = (repoRoot: string): boolean => {
  const source = gitShowText(BASELINE_COMMIT, 'package.json', repoRoot);
  if (!source) return false;
  try {
    const pkg = JSON.parse(source) as { version?: string };
    return pkg.version === BASELINE_VERSION;
  } catch {
    return false;
  }
};

export const verifyBaselineMigrationsMatch = (
  repoRoot: string,
): { fileMatchCount: number; match: boolean; reasons: string[] } => {
  const reasons: string[] = [];
  const files = listBaselineMigrationFiles(repoRoot);
  const fileMatchCount = files.length;

  if (files.length === 0) {
    reasons.push('missing-local-baseline-file');
  }

  // Bulk content equality: any diff under baseline-range SQL/snapshots is a mismatch.
  try {
    // Working tree (and index) vs baseline commit — catches committed and local drift.
    const changed = execFileSync(
      'git',
      ['diff', '--name-only', BASELINE_COMMIT, '--', MIGRATIONS_DIR],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((relativePath) => isBaselineMigrationPath(relativePath));

    if (changed.length > 0) {
      reasons.push('baseline-file-hash-mismatch');
    }
  } catch {
    reasons.push('baseline-git-diff-failed');
  }

  // Ensure every baseline-range file still exists at the baseline commit (no local-only drift).
  try {
    const baselineTree = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', BASELINE_COMMIT, '--', MIGRATIONS_DIR],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((relativePath) => isBaselineMigrationPath(relativePath));

    const localSet = new Set(files.map((file) => file.replaceAll('\\', '/')));
    const baselineSet = new Set(baselineTree);
    for (const relativePath of baselineSet) {
      if (!localSet.has(relativePath)) {
        reasons.push('missing-local-baseline-file');
        break;
      }
    }
    for (const relativePath of localSet) {
      if (!baselineSet.has(relativePath)) {
        reasons.push('missing-baseline-git-object');
        break;
      }
    }
  } catch {
    reasons.push('baseline-git-list-failed');
  }

  const journal = loadJournal(repoRoot);
  const baselineJournalSource = gitShowText(BASELINE_COMMIT, JOURNAL_RELATIVE_PATH, repoRoot);
  if (!baselineJournalSource) {
    reasons.push('missing-baseline-journal');
  } else {
    const baselineJournal = JSON.parse(baselineJournalSource) as JournalFile;
    if (baselineJournal.entries.length !== BASELINE_MIGRATION_COUNT) {
      reasons.push('baseline-journal-count-mismatch');
    }
    for (let idx = 0; idx <= BASELINE_MIGRATION_LAST_IDX; idx += 1) {
      const current = journal.entries[idx];
      const baseline = baselineJournal.entries[idx];
      if (!current || !baseline || current.tag !== baseline.tag || current.idx !== baseline.idx) {
        reasons.push('baseline-journal-tag-mismatch');
        break;
      }
    }
    if (baselineJournal.entries[BASELINE_MIGRATION_LAST_IDX]?.tag !== BASELINE_LAST_TAG) {
      reasons.push('baseline-last-tag-mismatch');
    }
  }

  if (journal.entries[BASELINE_MIGRATION_LAST_IDX]?.tag !== BASELINE_LAST_TAG) {
    reasons.push('current-last-baseline-tag-mismatch');
  }

  // De-dupe reasons while preserving order
  const uniqueReasons = [...new Set(reasons)];
  return {
    fileMatchCount,
    match: uniqueReasons.length === 0 && fileMatchCount > 0,
    reasons: uniqueReasons,
  };
};

export const verifyJournalSnapshotAlignment = (
  repoRoot: string,
): { match: boolean; totalEntries: number } => {
  const journal = loadJournal(repoRoot);
  const metaDir = path.join(repoRoot, MIGRATIONS_DIR, 'meta');
  const snapshots = readdirSync(metaDir).filter((name) => name.endsWith('_snapshot.json'));
  const expected = journal.entries.map(
    ({ idx }) => `${String(idx).padStart(4, '0')}_snapshot.json`,
  );
  const indexesOk = journal.entries.every((entry, index) => entry.idx === index);
  const tagsUnique = new Set(journal.entries.map(({ tag }) => tag)).size === journal.entries.length;
  const tagsPrefixed = journal.entries.every(({ idx, tag }) =>
    tag.startsWith(`${String(idx).padStart(4, '0')}_`),
  );
  const snapshotsOk =
    snapshots.toSorted().join('\0') === expected.toSorted().join('\0') &&
    indexesOk &&
    tagsUnique &&
    tagsPrefixed;

  return { match: snapshotsOk, totalEntries: journal.entries.length };
};

export const verifyBaseline = (repoRoot: string): BaselineVerification => {
  const versionOk = verifyBaselinePackageVersion(repoRoot);
  const migrationCheck = verifyBaselineMigrationsMatch(repoRoot);
  const reasons = [...migrationCheck.reasons];
  if (!versionOk) reasons.push('baseline-version-mismatch');

  return {
    baselineCommit: BASELINE_COMMIT,
    baselineVersion: BASELINE_VERSION,
    fileMatchCount: migrationCheck.fileMatchCount,
    lastTag: BASELINE_LAST_TAG,
    match: reasons.length === 0 && migrationCheck.match ? 'passed' : 'failed',
    migrationCount: BASELINE_MIGRATION_COUNT,
    reasons,
  };
};

export const allJournalEntries = (repoRoot: string): JournalEntry[] =>
  loadJournal(repoRoot).entries;
