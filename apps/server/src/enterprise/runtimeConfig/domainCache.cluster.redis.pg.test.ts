// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RedisConfig } from '@/libs/redis';
import { IoRedisRedisProvider } from '@/libs/redis/redis';
import {
  platformConfigKeys,
  RedisPlatformConfigInvalidationPublisher,
} from '@/server/enterprise/services/platformConfigInvalidation';

import { LoopbackFaultProxy } from '../../../../../scripts/enterprise/failure-drills/cluster/faultProxy';
import { ClusterProcessHarness } from '../../../../../scripts/enterprise/failure-drills/cluster/processHarness';

const execFileAsync = promisify(execFile);
const DATABASE_SCHEMA_PATTERN = /^o05b_[a-f0-9]{24}$/;
const DOCKER_ID_PATTERN = /^[a-f0-9]{64}$/;
const OWNERSHIP_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const REDIS_CONTAINER_LABEL = 'com.lobehub.failure-drill-token';
const REDIS_EPHEMERAL_LABEL = 'com.lobehub.failure-drill-ephemeral';
const TEST_RESOURCE_ID = 'o05b-branding';
const TEST_RESOURCE_TYPE = 'branding';
const CACHE_TTL_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const RUNTIME_REQUEST_TIMEOUT_MS = 60_000;

const databaseUrl = process.env.DATABASE_TEST_URL?.trim();
const redisUrl = process.env.TEST_REDIS_URL?.trim();
const redisContainerId = process.env.TEST_REDIS_OWNED_CONTAINER_ID?.trim();
const redisOwnershipToken = process.env.TEST_REDIS_OWNERSHIP_TOKEN?.trim();
const enabled =
  process.env.TEST_SERVER_DB === '1' &&
  process.env.TEST_REDIS_RESTART_OPT_IN === '1' &&
  Boolean(databaseUrl && redisUrl && redisContainerId && redisOwnershipToken);

interface DockerInspect {
  Config?: { Labels?: Record<string, string> };
  Id?: string;
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  };
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
    throw safeError('OwnedRedisContainerCommandFailed');
  }
};

const verifyOwnedRedisContainer = async (
  containerId: string,
  ownershipToken: string,
  connectionUrl: string,
): Promise<void> => {
  if (!DOCKER_ID_PATTERN.test(containerId) || !OWNERSHIP_TOKEN_PATTERN.test(ownershipToken)) {
    throw safeError('OwnedRedisContainerIdentityInvalid');
  }
  let inspected: DockerInspect[];
  try {
    inspected = JSON.parse(await runDocker(['inspect', containerId])) as DockerInspect[];
  } catch {
    throw safeError('OwnedRedisContainerInspectionFailed');
  }
  const container = inspected[0];
  const labels = container?.Config?.Labels;
  if (
    inspected.length !== 1 ||
    container?.Id !== containerId ||
    labels?.[REDIS_CONTAINER_LABEL] !== ownershipToken ||
    labels?.[REDIS_EPHEMERAL_LABEL] !== 'true'
  ) {
    throw safeError('OwnedRedisContainerOwnershipRejected');
  }
  const parsed = new URL(connectionUrl);
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw safeError('OwnedRedisContainerEndpointRejected');
  }
  const port = parsed.port || (parsed.protocol === 'rediss:' ? '6380' : '6379');
  const loopback =
    parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === 'localhost';
  const bindings = container.NetworkSettings?.Ports?.['6379/tcp'] ?? [];
  const boundToConnection = bindings.some(
    ({ HostIp, HostPort }) => HostPort === port && (HostIp === '127.0.0.1' || HostIp === '::1'),
  );
  if (!loopback || !boundToConnection) {
    throw safeError('OwnedRedisContainerEndpointRejected');
  }
};

const proxyUrl = (connectionUrl: string, port: number): string => {
  const parsed = new URL(connectionUrl);
  parsed.hostname = '127.0.0.1';
  parsed.port = String(port);
  return parsed.toString();
};

const loadRevision = async (runtime: ClusterProcessHarness): Promise<number> => {
  const response = await runtime.request('load');
  if (response.kind !== 'load') throw safeError('ClusterRuntimeUnexpectedResponse');
  return response.revision;
};

const childEnvironment = (input: {
  databaseSchema: string;
  databaseUrl: string;
  redisPrefix: string;
  redisUrl: string;
}): Record<string, string | undefined> => {
  const forwarded: Record<string, string | undefined> = {};
  for (const key of [
    'BUN_INSTALL',
    'NODE_EXTRA_CA_CERTS',
    'NODE_PATH',
    'PATH',
    'SSL_CERT_FILE',
    'TZ',
  ]) {
    if (process.env[key]) forwarded[key] = process.env[key];
  }
  return {
    ...forwarded,
    DATABASE_URL: input.databaseUrl,
    ENABLE_DATABASE_OIDC: '0',
    ENABLE_PLATFORM_ADMIN: '0',
    ENABLE_PLATFORM_MANAGED_AGENTS: '0',
    ENABLE_PLATFORM_MANAGED_AI: '0',
    ENABLE_PLATFORM_MANAGED_CONNECTORS: '0',
    ENABLE_PLATFORM_MANAGED_SKILLS: '0',
    ENABLE_PLATFORM_SETTINGS_POLICY: '0',
    ENABLE_RUNTIME_BRANDING: '1',
    NEXT_RUNTIME: 'nodejs',
    NODE_ENV: 'production',
    O05B_CACHE_TTL_MS: String(CACHE_TTL_MS),
    O05B_DATABASE_SCHEMA: input.databaseSchema,
    O05B_DATABASE_URL: input.databaseUrl,
    O05B_REDIS_PREFIX: input.redisPrefix,
    O05B_REDIS_URL: input.redisUrl,
  };
};

/**
 * This suite is intentionally skipped unless every real-service gate is present. In particular,
 * Redis restart requires an explicit opt-in plus a full container id carrying the per-run
 * ownership and ephemeral-data labels; a shared/local Redis can never satisfy this contract.
 */
describe.skipIf(!enabled)('Branding cache three-process Redis/Postgres failure drill', () => {
  const schemaName = `o05b_${randomBytes(12).toString('hex')}`;
  const redisPrefix = `o05b:${randomBytes(12).toString('hex')}`;
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const runtimeEntry = fileURLToPath(
    new URL(
      '../../../../../scripts/enterprise/failure-drills/cluster/runtimeInstance.ts',
      import.meta.url,
    ),
  );
  const bunExecutable = process.execPath.includes('bun') ? process.execPath : 'bun';
  const runtimes: ClusterProcessHarness[] = [];
  let adminPool: Pool | undefined;
  let faultProxy: LoopbackFaultProxy | undefined;
  let publisherRedis: IoRedisRedisProvider | undefined;
  let publisherRedisConfig: RedisConfig | undefined;
  let publisher: RedisPlatformConfigInvalidationPublisher | undefined;
  let ownedContainerVerified = false;

  const ownedKeys = [
    platformConfigKeys.globalVersion(),
    platformConfigKeys.resourceVersion(TEST_RESOURCE_TYPE, TEST_RESOURCE_ID),
    platformConfigKeys.scopeVersion('branding'),
    `platform:config:last_event:${TEST_RESOURCE_TYPE}:${TEST_RESOURCE_ID}`,
  ];

  beforeAll(async () => {
    if (!databaseUrl || !redisUrl || !redisContainerId || !redisOwnershipToken) {
      throw safeError('ClusterDrillGateInvariant');
    }
    if (!DATABASE_SCHEMA_PATTERN.test(schemaName)) throw safeError('ClusterDrillSchemaInvalid');
    await verifyOwnedRedisContainer(redisContainerId, redisOwnershipToken, redisUrl);
    ownedContainerVerified = true;

    const [{ Pool }, { getTestDB }] = await Promise.all([
      import('pg'),
      import('@/database/core/getTestDB'),
    ]);
    await getTestDB();
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    for (const table of [
      'platform_branding',
      'platform_instance_heartbeats',
      'platform_instance_revision_states',
    ]) {
      await adminPool.query(
        `CREATE TABLE "${schemaName}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    await adminPool.query(
      `INSERT INTO "${schemaName}".platform_branding
        (id, display_name, status, revision) VALUES ($1, $2, 'published', 1)`,
      [TEST_RESOURCE_ID, 'Brand revision one'],
    );

    const parsedRedisUrl = new URL(redisUrl);
    const upstreamPort = Number(
      parsedRedisUrl.port || (parsedRedisUrl.protocol === 'rediss:' ? 6380 : 6379),
    );
    faultProxy = new LoopbackFaultProxy({
      upstreamHost: parsedRedisUrl.hostname,
      upstreamPort,
    });
    const faultProxyPort = await faultProxy.start();

    publisherRedisConfig = {
      enabled: true,
      prefix: redisPrefix,
      tls: redisUrl.startsWith('rediss://'),
      url: redisUrl,
    } satisfies RedisConfig;
    publisherRedis = new IoRedisRedisProvider(publisherRedisConfig);
    await publisherRedis.initialize();
    await publisherRedis.del(...ownedKeys);
    publisher = new RedisPlatformConfigInvalidationPublisher({
      getRedisConfig: () => publisherRedisConfig!,
      initializeRedis: async () => publisherRedis!,
    });

    const runtimeUrls = [proxyUrl(redisUrl, faultProxyPort), redisUrl, redisUrl];
    for (const runtimeRedisUrl of runtimeUrls) {
      runtimes.push(
        new ClusterProcessHarness({
          args: [runtimeEntry],
          command: bunExecutable,
          cwd: repoRoot,
          env: childEnvironment({
            databaseSchema: schemaName,
            databaseUrl,
            redisPrefix,
            redisUrl: runtimeRedisUrl,
          }),
          requestTimeoutMs: RUNTIME_REQUEST_TIMEOUT_MS,
          startTimeoutMs: COMMAND_TIMEOUT_MS,
          stopTimeoutMs: 5_000,
        }),
      );
    }
    await Promise.all(runtimes.map((runtime) => runtime.start()));
  }, 120_000);

  afterAll(async () => {
    const cleanupErrors: Error[] = [];
    const capture = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
      try {
        await operation();
      } catch {
        cleanupErrors.push(safeError(`ClusterCleanup${name}Failed`));
      }
    };
    for (const [index, runtime] of runtimes.entries()) {
      await capture(`Runtime${index}Shutdown`, async () => {
        if (runtime.isRunning()) await runtime.shutdown();
      });
      if (runtime.isRunning()) {
        await capture(`Runtime${index}Terminate`, () => runtime.terminate());
      }
    }
    await capture('FaultProxy', async () => faultProxy?.close());
    await capture('RedisKeys', async () => {
      if (publisherRedis) await publisherRedis.del(...ownedKeys);
    });
    await capture('RedisClient', async () => publisherRedis?.disconnect());
    await capture('DatabaseSchema', async () => {
      if (adminPool && DATABASE_SCHEMA_PATTERN.test(schemaName)) {
        await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
      }
    });
    await capture('DatabasePool', async () => adminPool?.end());
    if (ownedContainerVerified && redisContainerId && DOCKER_ID_PATTERN.test(redisContainerId)) {
      await capture('RedisContainer', () => runDocker(['rm', '--force', redisContainerId]));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        `Cluster failure drill cleanup failed: ${cleanupErrors.map(({ name }) => name).join(',')}`,
      );
    }
  }, 120_000);

  it('keeps Postgres authoritative through one-process partition and Redis key loss', async () => {
    if (
      !adminPool ||
      !faultProxy ||
      !publisher ||
      !publisherRedis ||
      !publisherRedisConfig ||
      !redisContainerId
    ) {
      throw safeError('ClusterDrillNotInitialized');
    }
    await publisher.publish({
      at: new Date(0).toISOString(),
      resourceId: TEST_RESOURCE_ID,
      resourceType: TEST_RESOURCE_TYPE,
      revision: 1,
      scopes: ['branding'],
    });
    await expect(Promise.all(runtimes.map(loadRevision))).resolves.toEqual([1, 1, 1]);

    await adminPool.query(
      `UPDATE "${schemaName}".platform_branding SET display_name = $1, revision = 2 WHERE id = $2`,
      ['Brand revision two', TEST_RESOURCE_ID],
    );
    await expect(Promise.all(runtimes.map(loadRevision))).resolves.toEqual([1, 1, 1]);

    faultProxy.setPartitioned(true);
    await publisher.publish({
      at: new Date(0).toISOString(),
      resourceId: TEST_RESOURCE_ID,
      resourceType: TEST_RESOURCE_TYPE,
      revision: 2,
      scopes: ['branding'],
    });
    await expect(Promise.all(runtimes.map(loadRevision))).resolves.toEqual([2, 2, 2]);
    faultProxy.setPartitioned(false);
    await expect(loadRevision(runtimes[0]!)).resolves.toBe(2);

    await expect(publisherRedis.get(platformConfigKeys.scopeVersion('branding'))).resolves.toBe(
      '2',
    );
    await publisherRedis.disconnect();
    publisherRedis = undefined;
    await runDocker(['stop', '--time', '10', redisContainerId]);
    await runDocker(['start', redisContainerId]);

    await expect
      .poll(() => runDocker(['exec', redisContainerId, 'redis-cli', 'ping']), {
        interval: 250,
        timeout: 20_000,
      })
      .toBe('PONG');
    publisherRedis = new IoRedisRedisProvider(publisherRedisConfig);
    await publisherRedis.initialize();
    await expect(
      publisherRedis.get(platformConfigKeys.scopeVersion('branding')),
    ).resolves.toBeNull();
    await expect(Promise.all(runtimes.map(loadRevision))).resolves.toEqual([2, 2, 2]);

    await adminPool.query(
      `UPDATE "${schemaName}".platform_branding SET display_name = $1, revision = 3 WHERE id = $2`,
      ['Brand revision three', TEST_RESOURCE_ID],
    );
    await expect(Promise.all(runtimes.map(loadRevision))).resolves.toEqual([2, 2, 2]);
    await expect
      .poll(() => Promise.all(runtimes.map(loadRevision)), {
        interval: 250,
        timeout: CACHE_TTL_MS + 10_000,
      })
      .toEqual([3, 3, 3]);
    await expect(
      publisherRedis.get(platformConfigKeys.scopeVersion('branding')),
    ).resolves.toBeNull();

    const status = await runtimes[0]!.request('status');
    expect(status).toEqual({
      branding: {
        degraded: 0,
        diverged: 0,
        fresh: 3,
        matching: 3,
        status: 'converged',
        unreported: 0,
      },
      kind: 'status',
    });
    expect(runtimes.map((runtime) => runtime.getDiagnostics())).toEqual([
      { observedBytes: expect.any(Number), truncated: false },
      { observedBytes: expect.any(Number), truncated: false },
      { observedBytes: expect.any(Number), truncated: false },
    ]);
  }, 180_000);
});
