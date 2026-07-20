import { createInterface } from 'node:readline';

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as databaseSchema from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import type { RedisConfig } from '@/libs/redis';
import { IoRedisRedisProvider } from '@/libs/redis/redis';
import { BrandingPublishedReadService } from '@/server/enterprise/services/branding/publishedReadService';
import { RedisPlatformConfigVersionReader } from '@/server/enterprise/services/platformConfigInvalidation';
import {
  ensurePlatformInstanceHeartbeatStarted,
  resetPlatformInstanceHeartbeatForTest,
} from '@/server/enterprise/services/platformInstance/heartbeatRuntime';
import {
  resetPlatformRuntimeReporterForTest,
  waitForPlatformRuntimeReportsForTest,
} from '@/server/enterprise/services/platformInstance/runtimeReporter';
import { PlatformInstanceStatusService } from '@/server/enterprise/services/platformInstance/statusService';

import type { ClusterRuntimeRequest, ClusterRuntimeValue } from './protocol';

const CLEANUP_TIMEOUT_MS = 5_000;
const SAFE_SCHEMA = /^o05b_[a-f0-9]{24}$/;

const requiredEnv = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error('ClusterRuntimeConfigurationInvalid');
  return value;
};

const withTimeout = async (operation: Promise<unknown>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('ClusterRuntimeCleanupTimeout')),
          CLEANUP_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const writeMessage = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const isRequest = (value: unknown): value is ClusterRuntimeRequest => {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(request.id) &&
    (request.type === 'load' || request.type === 'shutdown' || request.type === 'status')
  );
};

const main = async (): Promise<void> => {
  const connectionString = requiredEnv('O05B_DATABASE_URL');
  const schemaName = requiredEnv('O05B_DATABASE_SCHEMA');
  const redisUrl = requiredEnv('O05B_REDIS_URL');
  const redisPrefix = requiredEnv('O05B_REDIS_PREFIX');
  if (!SAFE_SCHEMA.test(schemaName)) throw new Error('ClusterRuntimeConfigurationInvalid');

  const pool = new Pool({
    connectionString,
    max: 1,
    options: `-c search_path=${schemaName}`,
  });
  const db = drizzle(pool, { schema: databaseSchema }) as unknown as LobeChatDatabase;
  const redisConfig = {
    enabled: true,
    prefix: redisPrefix,
    tls: redisUrl.startsWith('rediss://'),
    url: redisUrl,
  } satisfies RedisConfig;
  const redis = new IoRedisRedisProvider(redisConfig);
  await redis.initialize();
  const versionReader = new RedisPlatformConfigVersionReader({
    getRedisConfig: () => redisConfig,
    initializeRedis: async () => redis,
  });
  const cacheTtlMs = Number(requiredEnv('O05B_CACHE_TTL_MS'));
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs <= 0) {
    throw new Error('ClusterRuntimeConfigurationInvalid');
  }

  const heartbeatStarted = await ensurePlatformInstanceHeartbeatStarted({
    getDatabase: async () => db,
  });
  if (!heartbeatStarted) throw new Error('ClusterRuntimeHeartbeatUnavailable');
  const branding = new BrandingPublishedReadService(db, {
    cacheTtlMs,
    getCacheEpoch: () => versionReader.getScopeVersion('branding'),
  });

  let cleanupStarted = false;
  const cleanup = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    resetPlatformInstanceHeartbeatForTest();
    resetPlatformRuntimeReporterForTest();
    const results = await Promise.allSettled([
      withTimeout(redis.disconnect()),
      withTimeout(pool.end()),
    ]);
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('ClusterRuntimeCleanupFailed');
    }
  };

  const execute = async (type: ClusterRuntimeRequest['type']): Promise<ClusterRuntimeValue> => {
    switch (type) {
      case 'load': {
        const published = await branding.getPublished();
        await waitForPlatformRuntimeReportsForTest();
        const revision = Number(published?.revision);
        if (!Number.isSafeInteger(revision) || revision <= 0) {
          throw new Error('ClusterRuntimeBrandingUnavailable');
        }
        return { kind: 'load', revision };
      }
      case 'status': {
        const snapshot = await new PlatformInstanceStatusService(db, {
          env: { ENABLE_RUNTIME_BRANDING: '1' },
        }).getStatus();
        const domain = snapshot.domains.find(({ domain }) => domain === 'branding');
        if (!domain) throw new Error('ClusterRuntimeStatusUnavailable');
        return {
          branding: {
            degraded: domain.counts.degraded,
            diverged: domain.counts.diverged,
            fresh: domain.counts.fresh,
            matching: domain.counts.matching,
            status: domain.status,
            unreported: domain.counts.unreported,
          },
          kind: 'status',
        };
      }
      case 'shutdown': {
        await cleanup();
        return { kind: 'shutdown' };
      }
    }
  };

  const lines = createInterface({ input: process.stdin, terminal: false });
  let tail = Promise.resolve();
  lines.on('line', (line) => {
    tail = tail.then(async () => {
      let request: unknown;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRequest(request)) return;
      try {
        const value = await execute(request.type);
        writeMessage({ id: request.id, ok: true, type: 'result', value });
        if (request.type === 'shutdown') {
          lines.close();
          process.exitCode = 0;
        }
      } catch {
        writeMessage({
          errorCategory: 'command_failed',
          id: request.id,
          ok: false,
          type: 'result',
        });
        if (request.type === 'shutdown') {
          lines.close();
          process.exitCode = 1;
        }
      }
    });
  });
  lines.once('close', () => {
    void tail.finally(() => {
      if (!cleanupStarted) {
        void cleanup().catch(() => {
          process.exitCode = 1;
        });
      }
    });
  });
  writeMessage({ type: 'ready' });
};

void main().catch(() => {
  process.stderr.write('cluster_runtime_initialization_failed\n');
  process.exitCode = 1;
});
