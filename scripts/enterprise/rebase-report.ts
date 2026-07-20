#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const REPORT_SCHEMA_VERSION = 1 as const;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const HASH_PATTERN = /^(?:[a-f\d]{40}|[a-f\d]{64})$/u;
const SHORT_HASH_LENGTH = 12;
const AUTHORITATIVE_LEDGER_PATH = 'docs/redevelopment/list/07_上游直接修改点台账.md';

const ENTERPRISE_OWNED_PREFIXES = [
  'apps/server/src/enterprise/',
  'docs/enterprise-patches/',
  'docs/redevelopment/',
  'e2e/enterprise-admin/',
  'packages/const/src/platform/',
  'packages/database/src/models/platform/',
  'packages/database/src/repositories/platform',
  'packages/database/src/schemas/platform/',
  'packages/types/src/platform/',
  'scripts/enterprise/',
  'src/enterprise/',
  'tests/enterprise/',
] as const;

type ReportFormat = 'json' | 'markdown';
type ReportStatus = 'clean' | 'conflicts' | 'drift';
type Risk = 'high' | 'low' | 'medium' | 'unknown';

interface GitResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface ChangedPath {
  /**
   * Present for rename (R*) and copy (C*) records from `git diff --name-status`.
   */
  destinationPath?: string;
  /**
   * Primary path for ordinary changes. For renames/copies this is the destination.
   */
  path: string;
  /**
   * Present for rename (R*) and copy (C*) records from `git diff --name-status`.
   */
  sourcePath?: string;
  status: string;
}

interface LedgerEntry {
  module: string;
  pattern: string;
  risk: Risk;
}

interface RebaseReportGate {
  id: string;
  reason: string;
}

export interface RebaseReport {
  analysis: {
    networkAccess: 'not-used';
    upstreamFreshness: 'unverified';
    upstreamFreshnessReason: 'caller-provided-ref-not-fetched' | 'upstream-remote-not-configured';
    worktreeMutation: 'none';
  };
  commits: {
    base: string;
    candidate: string;
    mergeBase: string;
    upstream: string;
  };
  conflicts: string[];
  directModificationHotspots: Array<{
    modules: string[];
    path: string;
    risk: Risk;
    upstreamChanged: boolean;
  }>;
  patchDrift: Array<{
    path: string;
    reason: 'unregistered-upstream-direct-edit';
  }>;
  requiredGates: RebaseReportGate[];
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  status: ReportStatus;
  summary: {
    candidateChangedPaths: number;
    conflicts: number;
    directModificationHotspots: number;
    patchDrift: number;
    upstreamChangedPaths: number;
  };
}

export interface AnalyzeRebaseOptions {
  baseRef: string;
  candidateRef: string;
  repositoryRoot: string;
  temporaryDirectoryRoot?: string;
  upstreamRef: string;
}

interface CliOptions extends AnalyzeRebaseOptions {
  format: ReportFormat;
}

const runProcess = async (command: string, args: string[], cwd?: string): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let exceededLimit = false;

    const collect = (chunks: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        exceededLimit = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (exceededLimit) {
        reject(new Error('Git output exceeded the safe analysis limit'));
        return;
      }
      resolve({
        code: code ?? 2,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });

const runGit = (repositoryRoot: string, args: string[]) =>
  runProcess('git', ['--no-optional-locks', '-C', repositoryRoot, ...args]);

const gitOutput = async (repositoryRoot: string, args: string[], failure: string) => {
  const result = await runGit(repositoryRoot, args);
  if (result.code !== 0) throw new Error(failure);
  return result.stdout;
};

const hasUnsafeControlCharacter = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });

const assertSafeRepositoryPath = (value: string): string => {
  if (
    !value ||
    value.length > 512 ||
    path.posix.isAbsolute(value) ||
    value === '..' ||
    value.startsWith('../') ||
    value.includes('/../') ||
    hasUnsafeControlCharacter(value) ||
    value.includes('`') ||
    value.includes('|')
  ) {
    throw new Error('Repository contains a path that cannot be represented safely');
  }
  return value;
};

const resolveCommit = async (repositoryRoot: string, ref: string, label: string) => {
  if (!ref || ref.length > 512 || hasUnsafeControlCharacter(ref)) {
    throw new Error(`${label} ref is invalid`);
  }
  const result = await runGit(repositoryRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  const hash = result.stdout.trim();
  if (result.code !== 0 || !HASH_PATTERN.test(hash)) throw new Error(`${label} ref is missing`);
  return hash;
};

const isRenameStatus = (status: string) => status.startsWith('R');
const isCopyStatus = (status: string) => status.startsWith('C');
const isRenameOrCopyStatus = (status: string) => isRenameStatus(status) || isCopyStatus(status);

const changePaths = (change: ChangedPath): string[] => {
  if (change.sourcePath && change.destinationPath) {
    return [change.sourcePath, change.destinationPath];
  }
  return [change.path];
};

const parseChangedPaths = (source: string): ChangedPath[] => {
  const fields = source.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes: ChangedPath[] = [];

  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) throw new Error('Git returned an invalid change record');
    if (isRenameOrCopyStatus(status)) {
      const sourcePath = fields[index++];
      const destinationPath = fields[index++];
      if (!sourcePath || !destinationPath) {
        throw new Error('Git returned an incomplete change record');
      }
      changes.push({
        destinationPath: assertSafeRepositoryPath(destinationPath),
        path: assertSafeRepositoryPath(destinationPath),
        sourcePath: assertSafeRepositoryPath(sourcePath),
        status,
      });
      continue;
    }

    const changedPath = fields[index++];
    if (!changedPath) throw new Error('Git returned an incomplete change record');
    changes.push({ path: assertSafeRepositoryPath(changedPath), status });
  }

  return changes.sort((left, right) => {
    const byPath = left.path.localeCompare(right.path, 'en');
    if (byPath !== 0) return byPath;
    const leftSource = left.sourcePath ?? '';
    const rightSource = right.sourcePath ?? '';
    return (
      leftSource.localeCompare(rightSource, 'en') || left.status.localeCompare(right.status, 'en')
    );
  });
};

const listChanges = async (repositoryRoot: string, from: string, to: string) =>
  parseChangedPaths(
    await gitOutput(
      repositoryRoot,
      // Detect renames and copies (including copies from unmodified sources) so
      // destination paths keep ledger coverage without losing source/destination semantics.
      [
        'diff',
        '--name-status',
        '-z',
        '--find-renames',
        '--find-copies',
        '--find-copies-harder',
        from,
        to,
        '--',
      ],
      'Unable to enumerate changed paths',
    ),
  );

const listTreePaths = async (repositoryRoot: string, commit: string) => {
  const source = await gitOutput(
    repositoryRoot,
    ['ls-tree', '-r', '--name-only', '-z', commit],
    'Unable to enumerate the base tree',
  );
  return new Set(source.split('\0').filter(Boolean).map(assertSafeRepositoryPath));
};

/**
 * Expand bash-style brace groups with balanced, depth-aware parsing.
 * Top-level commas split alternatives; nested braces expand recursively.
 * Unbalanced or unparseable patterns fail closed.
 */
export const expandBraces = (pattern: string): string[] => {
  if (!pattern.includes('{') && !pattern.includes('}')) return [pattern];

  let openingIndex = -1;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '}') {
      throw new Error('Patch ledger contains an unbalanced brace pattern');
    }
    if (character === '{') {
      openingIndex = index;
      break;
    }
  }
  if (openingIndex < 0) {
    throw new Error('Patch ledger contains an unbalanced brace pattern');
  }

  let depth = 0;
  let closingIndex = -1;
  for (let index = openingIndex; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        closingIndex = index;
        break;
      }
    }
  }
  if (closingIndex < 0 || depth !== 0) {
    throw new Error('Patch ledger contains an unbalanced brace pattern');
  }

  const body = pattern.slice(openingIndex + 1, closingIndex);
  if (body.length === 0) {
    throw new Error('Patch ledger contains an unparseable brace pattern');
  }

  const alternatives: string[] = [];
  let alternativeStart = 0;
  let alternativeDepth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '{') alternativeDepth += 1;
    if (character === '}') {
      alternativeDepth -= 1;
      if (alternativeDepth < 0) {
        throw new Error('Patch ledger contains an unbalanced brace pattern');
      }
    }
    if (character === ',' && alternativeDepth === 0) {
      alternatives.push(body.slice(alternativeStart, index));
      alternativeStart = index + 1;
    }
  }
  if (alternativeDepth !== 0) {
    throw new Error('Patch ledger contains an unbalanced brace pattern');
  }
  alternatives.push(body.slice(alternativeStart));

  if (alternatives.length < 2 || alternatives.some((alternative) => alternative.length === 0)) {
    throw new Error('Patch ledger contains an unparseable brace pattern');
  }

  const prefix = pattern.slice(0, openingIndex);
  const suffix = pattern.slice(closingIndex + 1);
  return alternatives.flatMap((alternative) => expandBraces(`${prefix}${alternative}${suffix}`));
};

const globToRegularExpression = (pattern: string) => {
  const regularExpressionSpecialCharacters = new Set([
    '\\',
    '^',
    '$',
    '.',
    '+',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
  ]);
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += regularExpressionSpecialCharacters.has(character) ? `\\${character}` : character;
  }
  return new RegExp(`${source}$`, 'u');
};

const normalizeRisk = (value: string): Risk => {
  const normalized = value.trim().toLowerCase();
  if (normalized === '高' || normalized === 'high') return 'high';
  if (normalized === '中' || normalized === 'medium') return 'medium';
  if (normalized === '低' || normalized === 'low') return 'low';
  return 'unknown';
};

export const parsePatchLedger = (source: string): LedgerEntry[] => {
  const entries: LedgerEntry[] = [];
  for (const line of source.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 5) continue;
    const patterns = [...cells[0].matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
    const module = cells[2].trim();
    const risk = normalizeRisk(cells[3]);
    if (!module || module === '模块' || module === 'Module') continue;
    for (const ledgerPattern of patterns) {
      if (!ledgerPattern.includes('/') && !ledgerPattern.includes('.')) continue;
      for (const pattern of expandBraces(ledgerPattern)) {
        if (/\s|→/u.test(pattern)) continue;
        entries.push({ module, pattern: assertSafeRepositoryPath(pattern), risk });
      }
    }
  }
  return entries.sort(
    (left, right) =>
      left.pattern.localeCompare(right.pattern, 'en') ||
      left.module.localeCompare(right.module, 'en'),
  );
};

const riskRank: Record<Risk, number> = { high: 3, low: 1, medium: 2, unknown: 0 };

const matchLedgerEntries = (repositoryPath: string, entries: LedgerEntry[]) =>
  entries.filter(({ pattern }) => globToRegularExpression(pattern).test(repositoryPath));

const isEnterpriseOwnedPath = (repositoryPath: string) =>
  ENTERPRISE_OWNED_PREFIXES.some((prefix) => repositoryPath.startsWith(prefix));

const readLedger = (repositoryRoot: string, candidate: string) =>
  gitOutput(
    repositoryRoot,
    ['show', `${candidate}:${AUTHORITATIVE_LEDGER_PATH}`],
    'Candidate is missing the authoritative patch ledger',
  );

const parseConflictPaths = (source: string): string[] => {
  const lines = source.split('\n');
  const treeHash = lines.shift()?.trim();
  if (!treeHash || !HASH_PATTERN.test(treeHash)) throw new Error('Merge analysis returned no tree');
  const conflicts: string[] = [];
  for (const line of lines) {
    if (!line) break;
    conflicts.push(assertSafeRepositoryPath(line));
  }
  return [...new Set(conflicts)].sort((left, right) => left.localeCompare(right, 'en'));
};

const analyzeMerge = async (
  repositoryRoot: string,
  upstream: string,
  candidate: string,
  temporaryDirectoryRoot?: string,
) => {
  const temporaryPrefix = path.join(temporaryDirectoryRoot ?? tmpdir(), 'aihub-rebase-report-');
  const temporaryRepository = await mkdtemp(temporaryPrefix);
  try {
    const clone = await runProcess('git', [
      'clone',
      '--quiet',
      '--shared',
      '--no-checkout',
      '--',
      repositoryRoot,
      temporaryRepository,
    ]);
    if (clone.code !== 0) throw new Error('Unable to create isolated merge analysis repository');

    const result = await runGit(temporaryRepository, [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--messages',
      upstream,
      candidate,
    ]);
    if (result.code !== 0 && result.code !== 1) throw new Error('Isolated merge analysis failed');
    return result.code === 1 ? parseConflictPaths(result.stdout) : [];
  } finally {
    await rm(temporaryRepository, { force: true, maxRetries: 3, recursive: true });
  }
};

const gateDefinitions = {
  'auth-e2e': 'Auth or OIDC hotspot changed; run trusted callback and login regression gates.',
  'bun-check-changed': 'Run the changed-file lint and focused-test gate.',
  'desktop-release': 'Desktop packaging hotspot changed; run branded release preflight gates.',
  'failure-drills': 'Runtime, Redis, observability, or instrumentation hotspot changed.',
  'manual-conflict-review': 'Resolve and independently review every reported merge conflict.',
  'migration-upgrade-rollback': 'Database schema or migration metadata changed.',
  'patch-ledger-update': 'Register every upstream direct edit in both patch ledgers.',
  'permission-matrix': 'Router, permission, or RBAC hotspot changed.',
  'privacy-review': 'Verify generated reports and conflict handling remain secret-free.',
  'spa-route-sync': 'SPA route hotspot changed; verify both desktop route trees stay aligned.',
  'type-check': 'Run the full repository type-check.',
} as const satisfies Record<string, string>;

const buildRequiredGates = (paths: string[], conflicts: string[], hasDrift: boolean) => {
  const gateIds = new Set<keyof typeof gateDefinitions>([
    'bun-check-changed',
    'privacy-review',
    'type-check',
  ]);
  const includesAny = (...needles: string[]) =>
    paths.some((repositoryPath) => needles.some((needle) => repositoryPath.includes(needle)));

  if (conflicts.length > 0) gateIds.add('manual-conflict-review');
  if (hasDrift) gateIds.add('patch-ledger-update');
  if (includesAny('/auth/', 'better-auth', 'oidc')) gateIds.add('auth-e2e');
  if (includesAny('migrations', 'database-schema', 'schemas/', '_journal.json'))
    gateIds.add('migration-upgrade-rollback');
  if (includesAny('router/', 'routers/', 'rbac', 'Permission', 'permission'))
    gateIds.add('permission-matrix');
  if (includesAny('redis', 'observability', 'instrumentation', 'runtimeConfig', 'platformInstance'))
    gateIds.add('failure-drills');
  if (includesAny('src/spa/router', 'createAdminRouteTree', 'BusinessDesktopRoutes'))
    gateIds.add('spa-route-sync');
  if (includesAny('apps/desktop', 'electron', 'desktop-publish')) gateIds.add('desktop-release');

  return [...gateIds]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((id) => ({ id, reason: gateDefinitions[id] }));
};

const shortHash = (hash: string) => hash.slice(0, SHORT_HASH_LENGTH);

export const analyzeRebase = async ({
  baseRef,
  candidateRef,
  repositoryRoot,
  temporaryDirectoryRoot,
  upstreamRef,
}: AnalyzeRebaseOptions): Promise<RebaseReport> => {
  const canonicalRoot = await realpath(repositoryRoot);
  const topLevel = (
    await gitOutput(canonicalRoot, ['rev-parse', '--show-toplevel'], 'Repository root is invalid')
  ).trim();
  if ((await realpath(topLevel)) !== canonicalRoot)
    throw new Error('Repository root must be top-level');

  const status = await gitOutput(
    canonicalRoot,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    'Unable to inspect repository status',
  );
  if (status.length > 0) throw new Error('Repository worktree must be clean');

  const [base, upstream, candidate] = await Promise.all([
    resolveCommit(canonicalRoot, baseRef, 'Base'),
    resolveCommit(canonicalRoot, upstreamRef, 'Upstream'),
    resolveCommit(canonicalRoot, candidateRef, 'Candidate'),
  ]);

  const mergeBases = (
    await gitOutput(
      canonicalRoot,
      ['merge-base', '--all', upstream, candidate],
      'Unable to resolve merge base',
    )
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  if (mergeBases.length !== 1 || mergeBases[0] !== base) {
    throw new Error('Explicit base does not match the unique upstream/candidate merge base');
  }

  const [candidateChanges, upstreamChanges, baseTree, ledgerSource, remotes] = await Promise.all([
    listChanges(canonicalRoot, base, candidate),
    listChanges(canonicalRoot, base, upstream),
    listTreePaths(canonicalRoot, base),
    readLedger(canonicalRoot, candidate),
    gitOutput(canonicalRoot, ['remote'], 'Unable to inspect configured remotes'),
  ]);
  const ledgerEntries = parsePatchLedger(ledgerSource);
  if (ledgerEntries.length === 0) throw new Error('Authoritative patch ledger has no path entries');

  const upstreamChangedPaths = new Set(upstreamChanges.flatMap(changePaths));
  /**
   * Paths that represent candidate-side direct edits of non-enterprise-owned content.
   * Renames/copies preserve source/destination semantics:
   * - rename: score BOTH source and destination independently
   *   - source existed in base and was deleted/moved; non-enterprise sources need ledger coverage
   *   - destination must independently satisfy enterprise ownership or ledger coverage
   * - copy: score destination only (source is unchanged; do not false-positive)
   * - ordinary edits still require presence in the base tree
   */
  const directEditPaths: string[] = [];
  for (const change of candidateChanges) {
    if (isRenameStatus(change.status)) {
      const sourcePath = change.sourcePath;
      const destinationPath = change.destinationPath ?? change.path;
      if (sourcePath && baseTree.has(sourcePath) && !isEnterpriseOwnedPath(sourcePath)) {
        directEditPaths.push(sourcePath);
      }
      if (!isEnterpriseOwnedPath(destinationPath)) {
        directEditPaths.push(destinationPath);
      }
      continue;
    }
    if (isCopyStatus(change.status)) {
      const destinationPath = change.destinationPath ?? change.path;
      if (!isEnterpriseOwnedPath(destinationPath)) {
        directEditPaths.push(destinationPath);
      }
      continue;
    }
    if (baseTree.has(change.path) && !isEnterpriseOwnedPath(change.path)) {
      directEditPaths.push(change.path);
    }
  }

  const directModificationHotspots: RebaseReport['directModificationHotspots'] = [];
  const patchDrift: RebaseReport['patchDrift'] = [];

  for (const repositoryPath of [...new Set(directEditPaths)].sort((left, right) =>
    left.localeCompare(right, 'en'),
  )) {
    const matches = matchLedgerEntries(repositoryPath, ledgerEntries);
    if (matches.length === 0) {
      patchDrift.push({ path: repositoryPath, reason: 'unregistered-upstream-direct-edit' });
      continue;
    }
    const risk = matches.reduce<Risk>(
      (highest, entry) => (riskRank[entry.risk] > riskRank[highest] ? entry.risk : highest),
      'unknown',
    );
    directModificationHotspots.push({
      modules: [...new Set(matches.map(({ module }) => module))].sort((left, right) =>
        left.localeCompare(right, 'en'),
      ),
      path: repositoryPath,
      risk,
      upstreamChanged: upstreamChangedPaths.has(repositoryPath),
    });
  }

  const conflicts = await analyzeMerge(canonicalRoot, upstream, candidate, temporaryDirectoryRoot);
  // Post-upgrade gates consider every candidate and upstream path (including enterprise-owned),
  // plus conflict paths. Drift/conflict-specific gates remain gated on those conditions.
  const gatePaths = [
    ...new Set([
      ...candidateChanges.flatMap(changePaths),
      ...upstreamChanges.flatMap(changePaths),
      ...conflicts,
    ]),
  ];
  const requiredGates = buildRequiredGates(gatePaths, conflicts, patchDrift.length > 0);
  const reportStatus: ReportStatus =
    conflicts.length > 0 ? 'conflicts' : patchDrift.length > 0 ? 'drift' : 'clean';
  const configuredRemotes = new Set(remotes.trim().split('\n').filter(Boolean));

  return {
    analysis: {
      networkAccess: 'not-used',
      upstreamFreshness: 'unverified',
      upstreamFreshnessReason: configuredRemotes.has('upstream')
        ? 'caller-provided-ref-not-fetched'
        : 'upstream-remote-not-configured',
      worktreeMutation: 'none',
    },
    commits: {
      base: shortHash(base),
      candidate: shortHash(candidate),
      mergeBase: shortHash(mergeBases[0]),
      upstream: shortHash(upstream),
    },
    conflicts,
    directModificationHotspots,
    patchDrift,
    requiredGates,
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: reportStatus,
    summary: {
      candidateChangedPaths: candidateChanges.length,
      conflicts: conflicts.length,
      directModificationHotspots: directModificationHotspots.length,
      patchDrift: patchDrift.length,
      upstreamChangedPaths: upstreamChanges.length,
    },
  };
};

const markdownPath = (repositoryPath: string) => `\`${repositoryPath}\``;

export const formatRebaseReport = (report: RebaseReport, format: ReportFormat): string => {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;

  const lines = [
    '# Enterprise upstream rebase report',
    '',
    `- Status: **${report.status}**`,
    `- Base / upstream / candidate: \`${report.commits.base}\` / \`${report.commits.upstream}\` / \`${report.commits.candidate}\``,
    `- Upstream freshness: **${report.analysis.upstreamFreshness}** (${report.analysis.upstreamFreshnessReason})`,
    '- Analysis mode: local-only, no network, no source worktree mutation',
    '',
    '## Summary',
    '',
    `- Candidate changed paths: ${report.summary.candidateChangedPaths}`,
    `- Upstream changed paths: ${report.summary.upstreamChangedPaths}`,
    `- Direct modification hotspots: ${report.summary.directModificationHotspots}`,
    `- Patch drift: ${report.summary.patchDrift}`,
    `- Conflicts: ${report.summary.conflicts}`,
    '',
    '## Conflicts',
    '',
    ...(report.conflicts.length > 0
      ? report.conflicts.map((repositoryPath) => `- ${markdownPath(repositoryPath)}`)
      : ['- None']),
    '',
    '## Direct modification hotspots',
    '',
    ...(report.directModificationHotspots.length > 0
      ? report.directModificationHotspots.map(
          ({ modules, path: repositoryPath, risk, upstreamChanged }) =>
            `- ${markdownPath(repositoryPath)} — modules=${modules.join(',')}; risk=${risk}; upstreamChanged=${upstreamChanged}`,
        )
      : ['- None']),
    '',
    '## Patch drift',
    '',
    ...(report.patchDrift.length > 0
      ? report.patchDrift.map(
          ({ path: repositoryPath, reason }) => `- ${markdownPath(repositoryPath)} — ${reason}`,
        )
      : ['- None']),
    '',
    '## Required gates',
    '',
    ...report.requiredGates.map(({ id, reason }) => `- **${id}** — ${reason}`),
    '',
  ];
  return lines.join('\n');
};

export const parseRebaseReportArgs = (args: string[], cwd: string): CliOptions => {
  const { values } = parseArgs({
    args,
    options: {
      base: { type: 'string' },
      candidate: { type: 'string' },
      format: { default: 'json', type: 'string' },
      repo: { default: cwd, type: 'string' },
      upstream: { type: 'string' },
    },
    strict: true,
  });
  if (!values.base) throw new Error('Missing required option: --base');
  if (!values.upstream) throw new Error('Missing required option: --upstream');
  if (!values.candidate) throw new Error('Missing required option: --candidate');
  if (values.format !== 'json' && values.format !== 'markdown') {
    throw new Error('--format must be json or markdown');
  }
  return {
    baseRef: values.base,
    candidateRef: values.candidate,
    format: values.format,
    repositoryRoot: path.resolve(cwd, values.repo),
    upstreamRef: values.upstream,
  };
};

export const runRebaseReportCli = async (args: string[], cwd = process.cwd()) => {
  try {
    const { format, ...options } = parseRebaseReportArgs(args, cwd);
    const report = await analyzeRebase(options);
    return { code: report.status === 'clean' ? 0 : 1, output: formatRebaseReport(report, format) };
  } catch (error) {
    return {
      code: 2,
      output: `Rebase report failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    };
  }
};

if (import.meta.main) {
  const result = await runRebaseReportCli(process.argv.slice(2));
  const log = result.code === 0 ? console.log : console.error;
  log(result.output.trimEnd());
  process.exitCode = result.code;
}
