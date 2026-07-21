/**
 * Owned ephemeral PostgreSQL for recovery drills (never shared phase0).
 * Connection strings never leave this module or enter evidence artifacts.
 */
import { execFile, spawn } from 'node:child_process';
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

export interface OwnedPostgresHandle {
  /** Opaque identity digest for source/target inequality checks (not a connection string). */
  identityDigest: string;
  /** Run pg_dump inside the owned container; returns binary dump bytes. */
  pgDumpCustom: () => Promise<Buffer>;
  /** Restore a custom-format dump into this owned database only. */
  pgRestoreCustom: (dump: Buffer) => Promise<void>;
  resourceToken: string;
  withClient: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
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
    pgDumpCustom: async () => {
      try {
        const { stdout: buffer } = await execFileAsync(
          'docker',
          ['exec', containerId, 'pg_dump', '-Fc', '-U', 'postgres', '-d', database],
          { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: DUMP_TIMEOUT_MS },
        );
        if (!Buffer.isBuffer(buffer) || buffer.byteLength < 16) {
          throw safeError('OwnedPostgresDumpEmpty');
        }
        return buffer;
      } catch {
        throw safeError('OwnedPostgresDumpFailed');
      }
    },
    pgRestoreCustom: async (dump: Buffer) => {
      if (!Buffer.isBuffer(dump) || dump.byteLength < 16) {
        throw safeError('OwnedPostgresRestoreInputInvalid');
      }
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'docker',
          [
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
          { stdio: ['pipe', 'pipe', 'pipe'] },
        );
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(safeError('OwnedPostgresRestoreTimeout'));
        }, DUMP_TIMEOUT_MS);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(safeError('OwnedPostgresRestoreFailed'));
        });
        child.stdin.write(dump);
        child.stdin.end();
      });
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
