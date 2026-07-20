import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import { Pool, type PoolClient } from 'pg';

import {
  OWNED_CONTAINER_LABEL_EPHEMERAL,
  OWNED_CONTAINER_LABEL_TOKEN,
  OWNED_POSTGRES_IMAGE,
  OWNED_RESOURCE_PREFIX,
} from './constants';

const execFileAsync = promisify(execFile);

const DOCKER_ID_PATTERN = /^[a-f0-9]{64}$/;
const OWNERSHIP_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const RESOURCE_TOKEN_PATTERN = new RegExp(`^${OWNED_RESOURCE_PREFIX}_[a-f0-9]{16}$`);

const COMMAND_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;

export interface OwnedPostgresHandle {
  /** Opaque report token only — never a connection string. */
  resourceToken: string;
  withClient: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
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

const runDocker = async (args: string[]): Promise<string> => {
  try {
    const { stdout } = await execFileAsync('docker', args, {
      maxBuffer: 64 * 1024,
      timeout: COMMAND_TIMEOUT_MS,
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
  let lastError: unknown;
  while (Date.now() - started < READY_TIMEOUT_MS) {
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 2000, max: 1 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  }
  void lastError;
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

  // Publish only to loopback with an ephemeral host port (docker chooses).
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

  let cleaned = false;
  const cleanup = async (): Promise<'failed' | 'passed'> => {
    if (cleaned) return 'passed';
    cleaned = true;
    try {
      const container = await inspectContainer(containerId);
      verifyOwnership(container, containerId, ownershipToken);
      await runDocker(['rm', '-f', containerId]);
      return 'passed';
    } catch {
      return 'failed';
    }
  };

  try {
    const container = await inspectContainer(containerId);
    verifyOwnership(container, containerId, ownershipToken);
    const bindings = container.NetworkSettings?.Ports?.['5432/tcp'] ?? [];
    const hostPort = bindings.find(
      (binding) => binding?.HostIp === '127.0.0.1' || binding?.HostIp === '::1',
    )?.HostPort;
    if (!hostPort) throw safeError('OwnedPostgresPortBindingMissing');

    const connectionString = buildConnectionString(hostPort, database, password);
    await waitForReady(connectionString);

    // Ensure vector extension for migrations that need it (ParadeDB image includes it).
    const bootstrap = new Pool({ connectionString, max: 1 });
    try {
      await bootstrap.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch {
      // Some images expose vector under a different path; migrations that need it will fail later.
    } finally {
      await bootstrap.end();
    }

    const handle: OwnedPostgresHandle = {
      resourceToken,
      withClient: async (fn) => {
        const pool = new Pool({ connectionString, max: 1 });
        const client = await pool.connect();
        try {
          return await fn(client);
        } finally {
          client.release();
          await pool.end();
        }
      },
    };

    return { cleanup, handle };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

export const isOwnedResourceToken = (token: string): boolean => RESOURCE_TOKEN_PATTERN.test(token);
