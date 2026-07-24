/**
 * Owned ephemeral PostgreSQL for recovery drills (never shared phase0).
 * Connection strings never leave this module or enter evidence artifacts.
 */
import { type ChildProcess, execFile, spawn, type StdioOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { Pool, type PoolClient } from 'pg';

import {
  OWNED_CONTAINER_LABEL_EPHEMERAL,
  OWNED_CONTAINER_LABEL_TOKEN,
  OWNED_POSTGRES_IMAGE,
  OWNED_RESOURCE_PREFIX,
} from '../constants';

const execFileAsync = promisify(execFile);

const DOCKER_ID_PATTERN = /^[a-f0-9]{64}$/;
const OWNERSHIP_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const RESOURCE_TOKEN_PATTERN = new RegExp(`^${OWNED_RESOURCE_PREFIX}_[a-f0-9]{16}$`);

const COMMAND_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const DUMP_TIMEOUT_MS = 120_000;
/** Grace window between SIGTERM and SIGKILL on timeout escalation. */
const KILL_GRACE_MS = 2_000;

export type BoundedChildOutcome =
  | { kind: 'error'; error: Error }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null; stdout: Buffer }
  | { kind: 'timeout'; code: number | null; signal: NodeJS.Signals | null };

export interface RunBoundedChildOptions {
  args: readonly string[];
  command: string;
  /** Milliseconds after SIGTERM before SIGKILL (default 2000). */
  killGraceMs?: number;
  /** Optional hook after spawn (tests capture pid for reaped-after-settle asserts). */
  onSpawn?: (child: ChildProcess) => void;
  /** Optional stdin payload (enables pipe stdin). */
  stdin?: Buffer;
  /**
   * stdio triple. Defaults:
   * - with stdin: ['pipe','ignore','ignore']
   * - without: ['ignore','pipe','pipe'] (collect stdout, drain/discard stderr)
   */
  stdio?: StdioOptions;
  timeoutMs: number;
}

/**
 * Spawn a child and settle the promise only after the process has closed.
 *
 * On timeout: SIGTERM → killGraceMs → SIGKILL, then await 'close'/'exit' before
 * resolving `{ kind: 'timeout' }`. The child never outlives the settled promise.
 */
export const runBoundedChild = (options: RunBoundedChildOptions): Promise<BoundedChildOutcome> =>
  new Promise((resolve) => {
    const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    const collectStdout =
      options.stdio === undefined && options.stdin === undefined
        ? true
        : Array.isArray(options.stdio) && options.stdio[1] === 'pipe';
    const stdio: StdioOptions =
      options.stdio ??
      (options.stdin !== undefined ? ['pipe', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe']);

    const child: ChildProcess = spawn(options.command, [...options.args], { stdio });
    options.onSpawn?.(child);
    const chunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let stdinFatal: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (outcome: BoundedChildOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(outcome);
    };

    const escalateAndAwaitClose = () => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // already exited
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, killGraceMs);
      // If already reaped, settle immediately as timeout.
      if (child.exitCode !== null || child.signalCode !== null) {
        settle({
          code: child.exitCode,
          kind: 'timeout',
          signal: child.signalCode,
        });
      }
      // Otherwise 'close' handler settles with timedOut=true.
    };

    const timer = setTimeout(() => {
      escalateAndAwaitClose();
    }, options.timeoutMs);

    if (collectStdout && child.stdout) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
    }
    // Drain stderr when piped to avoid pipe-buffer deadlock; discard content (privacy).
    if (child.stderr) {
      child.stderr.on('data', () => undefined);
    }

    child.on('error', (error) => {
      // Spawn failures (ENOENT, …) have no 'close' — settle immediately.
      settle({ error, kind: 'error' });
    });

    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        settle({ code, kind: 'timeout', signal });
        return;
      }
      if (stdinFatal) {
        settle({ error: stdinFatal, kind: 'error' });
        return;
      }
      settle({
        code,
        kind: 'exit',
        signal,
        stdout: Buffer.concat(chunks),
      });
    });

    if (options.stdin !== undefined && child.stdin) {
      const stdin = child.stdin;
      stdin.on('error', (error) => {
        // EPIPE when the child exits mid-write is common; 'close' reports the real exit.
        if (settled || timedOut) return;
        if ((error as NodeJS.ErrnoException).code === 'EPIPE') return;
        // Record and terminate; settle only after 'close' so no orphan outlives the promise.
        stdinFatal = error;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      });
      try {
        const writeOk = stdin.write(options.stdin);
        if (writeOk) {
          stdin.end();
        } else {
          stdin.once('drain', () => {
            stdin.end();
          });
        }
      } catch (error) {
        stdinFatal = error instanceof Error ? error : new Error(String(error));
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }
    }
  });

export interface OwnedPostgresHandle {
  /** Opaque identity digest for source/target inequality checks (not a connection string). */
  identityDigest: string;
  /** Run pg_dump inside the owned container; returns binary dump bytes. */
  pgDumpCustom: () => Promise<Buffer>;
  /** Restore a custom-format dump into this owned database only. */
  pgRestoreCustom: (dump: Buffer) => Promise<void>;
  resourceToken: string;
  withClient: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  /**
   * Borrow DATABASE_URL for a callback only. Never log or store the URL.
   * Used to bind baseline probe processes to this owned DB.
   */
  withDatabaseUrl: <T>(fn: (databaseUrl: string) => Promise<T>) => Promise<T>;
  withPool: <T>(fn: (pool: Pool, client: PoolClient) => Promise<T>) => Promise<T>;
}

export interface OwnedPostgresLifecycle {
  cleanup: () => Promise<'failed' | 'passed'>;
  handle: OwnedPostgresHandle;
}

interface DockerInspect {
  Config?: { Labels?: Record<string, string> };
  Id?: string;
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
  State?: { Running?: boolean };
}

const safeError = (name: string): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

const runDocker = async (args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout.trim();
  } catch {
    throw safeError('OwnedPostgresContainerCommandFailed');
  }
};

const buildResourceToken = (): string =>
  `${OWNED_RESOURCE_PREFIX}_${randomBytes(8).toString('hex')}`;

const buildOwnershipToken = (): string => randomBytes(16).toString('hex');

const buildConnectionString = (port: string, database: string, password: string): string =>
  `postgres://postgres:${password}@127.0.0.1:${port}/${database}`;

const waitForReady = async (connectionString: string): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < READY_TIMEOUT_MS) {
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 2000, max: 1 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  }
  throw safeError('OwnedPostgresReadyTimeout');
};

const inspectContainer = async (containerId: string): Promise<DockerInspect> => {
  const raw = await runDocker(['inspect', containerId]);
  const parsed = JSON.parse(raw) as DockerInspect[];
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw safeError('OwnedPostgresInspectionFailed');
  }
  return parsed[0]!;
};

const verifyOwnership = (
  container: DockerInspect,
  containerId: string,
  ownershipToken: string,
): void => {
  if (!DOCKER_ID_PATTERN.test(containerId) || !OWNERSHIP_TOKEN_PATTERN.test(ownershipToken)) {
    throw safeError('OwnedPostgresIdentityInvalid');
  }
  const labels = container.Config?.Labels ?? {};
  if (
    container.Id !== containerId ||
    labels[OWNED_CONTAINER_LABEL_TOKEN] !== ownershipToken ||
    labels[OWNED_CONTAINER_LABEL_EPHEMERAL] !== 'true'
  ) {
    throw safeError('OwnedPostgresOwnershipRejected');
  }
};

const digestIdentity = (resourceToken: string, ownershipToken: string): string =>
  createHash('sha256').update(`${resourceToken}:${ownershipToken}`).digest('hex');

/**
 * Provision a random owned disposable Postgres container + database.
 * Never targets shared phase0 (aihub-dev) resources.
 */
export const createOwnedPostgres = async (): Promise<OwnedPostgresLifecycle> => {
  const resourceToken = buildResourceToken();
  const ownershipToken = buildOwnershipToken();
  const password = randomBytes(18).toString('base64url');
  const database = resourceToken;

  if (!RESOURCE_TOKEN_PATTERN.test(resourceToken)) {
    throw safeError('OwnedPostgresResourceTokenInvalid');
  }

  const containerId = await runDocker([
    'run',
    '-d',
    '--rm',
    '--name',
    resourceToken,
    '--label',
    `${OWNED_CONTAINER_LABEL_TOKEN}=${ownershipToken}`,
    '--label',
    `${OWNED_CONTAINER_LABEL_EPHEMERAL}=true`,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${database}`,
    '-p',
    '127.0.0.1::5432',
    OWNED_POSTGRES_IMAGE,
  ]);

  if (!DOCKER_ID_PATTERN.test(containerId)) {
    throw safeError('OwnedPostgresContainerIdInvalid');
  }

  let connectionString: string | undefined;
  try {
    const inspected = await inspectContainer(containerId);
    verifyOwnership(inspected, containerId, ownershipToken);
    const bindings = inspected.NetworkSettings?.Ports?.['5432/tcp'];
    const hostPort = bindings?.[0]?.HostPort;
    if (!hostPort) throw safeError('OwnedPostgresPortBindingMissing');
    connectionString = buildConnectionString(hostPort, database, password);
    await waitForReady(connectionString);
  } catch (error) {
    await runDocker(['rm', '-f', containerId]).catch(() => undefined);
    throw error;
  }

  const pool = new Pool({ connectionString, max: 4 });
  const identityDigest = digestIdentity(resourceToken, ownershipToken);

  const handle: OwnedPostgresHandle = {
    identityDigest,
    resourceToken,
    withDatabaseUrl: async (fn) => {
      if (!connectionString) throw safeError('OwnedPostgresConnectionMissing');
      return fn(connectionString);
    },
    pgDumpCustom: async () => {
      // Stream dump chunks via runBoundedChild — no fixed maxBuffer ceiling.
      // Timeout path awaits child close (SIGTERM→SIGKILL) before rejecting.
      const outcome = await runBoundedChild({
        args: ['exec', containerId, 'pg_dump', '-Fc', '-U', 'postgres', '-d', database],
        command: 'docker',
        killGraceMs: KILL_GRACE_MS,
        timeoutMs: DUMP_TIMEOUT_MS,
      });
      if (outcome.kind === 'timeout') throw safeError('OwnedPostgresDumpTimeout');
      if (outcome.kind === 'error') throw outcome.error;
      if (outcome.code !== 0) throw safeError('OwnedPostgresDumpFailed');
      if (outcome.stdout.byteLength < 16) throw safeError('OwnedPostgresDumpEmpty');
      return outcome.stdout;
    },
    pgRestoreCustom: async (dump: Buffer) => {
      if (!Buffer.isBuffer(dump) || dump.byteLength < 16) {
        throw safeError('OwnedPostgresRestoreInputInvalid');
      }
      // stdin streams dump; stdout/stderr ignored to avoid pipe-buffer deadlock.
      // Timeout path awaits child close (SIGTERM→SIGKILL) before rejecting.
      const outcome = await runBoundedChild({
        args: [
          'exec',
          '-i',
          containerId,
          'pg_restore',
          '-U',
          'postgres',
          '-d',
          database,
          '--clean',
          '--if-exists',
        ],
        command: 'docker',
        killGraceMs: KILL_GRACE_MS,
        stdin: dump,
        stdio: ['pipe', 'ignore', 'ignore'],
        timeoutMs: DUMP_TIMEOUT_MS,
      });
      if (outcome.kind === 'timeout') throw safeError('OwnedPostgresRestoreTimeout');
      if (outcome.kind === 'error') throw outcome.error;
      if (outcome.code !== 0) throw safeError('OwnedPostgresRestoreFailed');
    },
    withClient: async (fn) => {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    withPool: async (fn) => {
      const client = await pool.connect();
      try {
        return await fn(pool, client);
      } finally {
        client.release();
      }
    },
  };

  const cleanup = async (): Promise<'failed' | 'passed'> => {
    try {
      await pool.end().catch(() => undefined);
      const inspected = await inspectContainer(containerId);
      verifyOwnership(inspected, containerId, ownershipToken);
      await runDocker(['rm', '-f', containerId]);
      return 'passed';
    } catch {
      return 'failed';
    }
  };

  return { cleanup, handle };
};

export const isOwnedResourceToken = (value: string): boolean => RESOURCE_TOKEN_PATTERN.test(value);

export const assertDistinctIdentities = (source: string, target: string): void => {
  if (source === target) {
    throw safeError('OwnedPostgresSourceTargetIdentical');
  }
};
