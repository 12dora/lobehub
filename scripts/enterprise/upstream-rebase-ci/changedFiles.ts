import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

interface GitResult {
  code: number;
  stdout: string;
}

const runGit = (cwd: string, args: string[]): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['--no-optional-locks', '-C', cwd, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code: code ?? 2, stdout: Buffer.concat(stdout).toString('utf8') });
    });
  });

const listNameOnly = async (repositoryRoot: string, from: string, to: string) => {
  const result = await runGit(repositoryRoot, [
    'diff',
    '--name-only',
    '-z',
    '--find-renames',
    from,
    to,
    '--',
  ]);
  if (result.code !== 0) {
    throw new Error('Unable to enumerate changed paths for gates');
  }
  return result.stdout.split('\0').filter(Boolean);
};

const LINTABLE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
  '.yml',
  '.yaml',
  '.json',
]);

/**
 * Union of paths changed on candidate and upstream relative to the explicit base.
 */
export const listChangedPathsForGates = async (
  repositoryRoot: string,
  base: string,
  candidate: string,
  upstream: string,
): Promise<string[]> => {
  const [candidatePaths, upstreamPaths] = await Promise.all([
    listNameOnly(repositoryRoot, base, candidate),
    listNameOnly(repositoryRoot, base, upstream),
  ]);
  return [...new Set([...candidatePaths, ...upstreamPaths])].sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
};

export const filterExistingLintablePaths = async (
  repositoryRoot: string,
  relativePaths: string[],
): Promise<string[]> => {
  const existing: string[] = [];
  for (const relativePath of relativePaths) {
    if (relativePath.includes('\0') || relativePath.startsWith('../')) continue;
    const extension = path.extname(relativePath).toLowerCase();
    if (!LINTABLE_EXTENSIONS.has(extension)) continue;
    const absolute = path.join(repositoryRoot, relativePath);
    try {
      await access(absolute);
      existing.push(relativePath);
    } catch {
      // deleted on one side — skip
    }
  }
  return existing;
};
