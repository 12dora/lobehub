import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';

export interface RemoveRunnerResult {
  code: number;
}

export type RemoveRunner = (target: string) => Promise<RemoveRunnerResult>;

const defaultRmRf: RemoveRunner = (target) =>
  new Promise((resolve, reject) => {
    const child = spawn('rm', ['-rf', '--', target], {
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code: code ?? 1 });
    });
  });

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

/**
 * Exact removal: both a zero exit code from `rm` and path absence are required.
 * A nonzero exit fails even if the path has already disappeared.
 */
export const removePathExact = async (
  target: string,
  remove: RemoveRunner = defaultRmRf,
): Promise<void> => {
  const existedBefore = await pathExists(target);
  if (!existedBefore) {
    // Already absent is success only when we did not need to delete.
    return;
  }

  const { code } = await remove(target);
  const existsAfter = await pathExists(target);

  if (code !== 0) {
    throw new Error(
      `Cleanup failed: rm exited ${code}${existsAfter ? ' and path still exists' : ' even though path is gone'}`,
    );
  }
  if (existsAfter) {
    throw new Error('Cleanup failed: path still exists after rm exit 0');
  }
};

export const removeDirectoryExact = removePathExact;
