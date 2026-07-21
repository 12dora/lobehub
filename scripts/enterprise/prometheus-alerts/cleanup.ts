import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

export interface CleanupTarget {
  containers?: string[];
  networks?: string[];
  tempDirs?: string[];
}

export interface CleanupResult {
  errors: Error[];
  residue: string[];
}

const runDocker = (args: string[]): void => {
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
};

const containerExists = (name: string): boolean => {
  try {
    const out = execFileSync('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '-q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
    return out.length > 0;
  } catch {
    // If we cannot list containers, treat as residue to fail closed.
    return true;
  }
};

const networkExists = (name: string): boolean => {
  try {
    const out = execFileSync('docker', ['network', 'ls', '--filter', `name=^${name}$`, '-q'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).trim();
    return out.length > 0;
  } catch {
    return true;
  }
};

/**
 * Remove probe/runtime resources and verify absence. Never silently succeeds with residue.
 * Optional inject hooks support falsification tests.
 */
export const cleanupProbeResources = (
  target: CleanupTarget,
  options?: {
    injectContainerRmError?: (name: string) => Error | null;
    injectNetworkRmError?: (name: string) => Error | null;
    skipVerify?: boolean;
  },
): CleanupResult => {
  const errors: Error[] = [];
  const residue: string[] = [];

  for (const name of target.containers ?? []) {
    try {
      const injected = options?.injectContainerRmError?.(name) ?? null;
      if (injected) throw injected;
      runDocker(['rm', '-f', name]);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error
          : new Error(`container rm failed for ${name}: ${String(error)}`),
      );
    }
  }

  for (const name of target.networks ?? []) {
    try {
      const injected = options?.injectNetworkRmError?.(name) ?? null;
      if (injected) throw injected;
      runDocker(['network', 'rm', name]);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error
          : new Error(`network rm failed for ${name}: ${String(error)}`),
      );
    }
  }

  for (const dir of target.tempDirs ?? []) {
    try {
      rmSync(dir, { force: true, recursive: true });
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error
          : new Error(`temp dir rm failed for ${dir}: ${String(error)}`),
      );
    }
  }

  if (!options?.skipVerify) {
    for (const name of target.containers ?? []) {
      if (containerExists(name)) residue.push(`container:${name}`);
    }
    for (const name of target.networks ?? []) {
      if (networkExists(name)) residue.push(`network:${name}`);
    }
    for (const dir of target.tempDirs ?? []) {
      if (existsSync(dir)) residue.push(`tempDir:${dir}`);
    }
  }

  return { errors, residue };
};

/** Throw AggregateError combining primary failure with cleanup failures/residue. */
export const throwWithCleanup = (primary: unknown, cleanup: CleanupResult): never => {
  const cleanupMessages = [
    ...cleanup.errors.map((error) => error.message),
    ...cleanup.residue.map((item) => `residue remains: ${item}`),
  ];
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  if (cleanupMessages.length === 0) {
    throw primary instanceof Error ? primary : new Error(primaryMessage);
  }
  throw new AggregateError(
    [
      primary instanceof Error ? primary : new Error(primaryMessage),
      ...cleanup.errors,
      ...cleanup.residue.map((item) => new Error(`residue remains: ${item}`)),
    ],
    `${primaryMessage}; cleanup also failed: ${cleanupMessages.join('; ')}`,
  );
};

/** Fail closed when cleanup itself failed or left residue (no primary error). */
export const assertCleanupClean = (cleanup: CleanupResult): void => {
  if (cleanup.errors.length === 0 && cleanup.residue.length === 0) return;
  const messages = [
    ...cleanup.errors.map((error) => error.message),
    ...cleanup.residue.map((item) => `residue remains: ${item}`),
  ];
  throw new AggregateError(
    [...cleanup.errors, ...cleanup.residue.map((item) => new Error(`residue remains: ${item}`))],
    `cleanup failed closed: ${messages.join('; ')}`,
  );
};
