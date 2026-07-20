import debug from 'debug';

import type { PlatformResourceType } from '@/database/schemas/platform';
import { getRedisConfig } from '@/envs/redis';
import type { BaseRedisProvider, RedisConfig } from '@/libs/redis';
import { initializeRedis } from '@/libs/redis';

const log = debug('lobe-server:platform-config-invalidation');
const LAST_EVENT_TTL_SECONDS = 86_400;
const MAX_IN_MEMORY_EVENTS = 256;
const MAX_INVALIDATION_SCOPES = 32;
const MAX_INVALIDATION_SCOPE_LENGTH = 128;

const getErrorClass = (error: unknown): string =>
  error instanceof Error && error.name ? error.name : 'UnknownError';

const normalizeScopes = (scopes: string[] | undefined): string[] => {
  if (!scopes) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawScope of scopes) {
    const scope = rawScope.trim();
    if (!scope || scope.length > MAX_INVALIDATION_SCOPE_LENGTH || seen.has(scope)) continue;
    seen.add(scope);
    normalized.push(scope);
    if (normalized.length === MAX_INVALIDATION_SCOPES) break;
  }
  return normalized;
};

/**
 * Event emitted after a successful platform publish / rollback.
 * Consumers bump Redis version keys or drop local caches.
 *
 * Database remains the source of truth — Redis loss is recoverable by
 * rebuilding from DB; cache must never overwrite the database.
 */
export interface PlatformConfigInvalidationEvent {
  at: string;
  resourceId: string;
  resourceType: PlatformResourceType | string;
  revision: number;
  /** Optional domain scopes that should refresh (settings, catalog, branding…). */
  scopes?: string[];
}

export interface PlatformConfigInvalidationPublisher {
  publish: (event: PlatformConfigInvalidationEvent) => Promise<void>;
}

export interface PlatformConfigVersionReader {
  getScopeVersion: (scope: string) => Promise<string>;
}

export interface PlatformConfigRedisDependencies {
  getRedisConfig: () => RedisConfig;
  initializeRedis: (config: RedisConfig) => Promise<BaseRedisProvider | null>;
}

const defaultRedisDependencies: PlatformConfigRedisDependencies = {
  getRedisConfig,
  initializeRedis,
};

/** Redis key builders for platform config versioning (local to enterprise). */
export const platformConfigKeys = {
  globalVersion: () => 'platform:config:version',
  resourceVersion: (resourceType: string, resourceId: string) =>
    `platform:config:version:${resourceType}:${resourceId}`,
  scopeVersion: (scope: string) => `platform:config:scope:${scope}:version`,
};

/**
 * In-memory publisher for single-process / tests.
 * Stores the latest event per resource key.
 */
export class InMemoryPlatformConfigInvalidationPublisher
  implements PlatformConfigInvalidationPublisher, PlatformConfigVersionReader
{
  readonly events: PlatformConfigInvalidationEvent[] = [];
  readonly versions = new Map<string, number>();

  publish = async (event: PlatformConfigInvalidationEvent): Promise<void> => {
    const scopes = normalizeScopes(event.scopes);
    this.events.push({ ...event, scopes });
    if (this.events.length > MAX_IN_MEMORY_EVENTS) {
      this.events.splice(0, this.events.length - MAX_IN_MEMORY_EVENTS);
    }
    this.versions.set(`${event.resourceType}:${event.resourceId}`, event.revision);
    this.versions.set('global', Math.max((this.versions.get('global') ?? 0) + 1, event.revision));
    for (const scope of scopes) {
      const key = `scope:${scope}`;
      this.versions.set(key, Math.max((this.versions.get(key) ?? 0) + 1, event.revision));
    }
  };

  getScopeVersion = async (scope: string): Promise<string> =>
    String(this.versions.get(`scope:${scope}`) ?? 0);
}

/**
 * Best-effort Redis version-key publisher.
 * Failures are logged and swallowed so publish transactions are not rolled back.
 */
export class RedisPlatformConfigInvalidationPublisher implements PlatformConfigInvalidationPublisher {
  constructor(
    private readonly redisDependencies: PlatformConfigRedisDependencies = defaultRedisDependencies,
  ) {}

  publish = async (event: PlatformConfigInvalidationEvent): Promise<void> => {
    try {
      const config = this.redisDependencies.getRedisConfig();
      if (!config.enabled) {
        log('redis disabled; invalidation degraded resourceType=%s', event.resourceType);
        return;
      }

      const redis = await this.redisDependencies.initializeRedis(config);
      if (!redis) {
        log('redis unavailable; invalidation degraded resourceType=%s', event.resourceType);
        return;
      }

      const scopes = normalizeScopes(event.scopes);
      const pipeline = redis.pipeline();
      pipeline.incr(platformConfigKeys.globalVersion());
      pipeline.set(
        platformConfigKeys.resourceVersion(event.resourceType, event.resourceId),
        String(event.revision),
      );
      for (const scope of scopes) {
        pipeline.incr(platformConfigKeys.scopeVersion(scope));
      }
      // Store a small envelope for diagnostics / multi-instance watchers.
      pipeline.set(
        `platform:config:last_event:${event.resourceType}:${event.resourceId}`,
        JSON.stringify({ ...event, scopes }),
        { ex: LAST_EVENT_TTL_SECONDS },
      );
      const results = await pipeline.exec();
      const expectedCommands = scopes.length + 3;
      const failedCommands = results
        ? results.filter(([error]) => error !== null).length +
          Math.max(0, expectedCommands - results.length)
        : expectedCommands;
      if (failedCommands > 0) {
        log(
          'invalidation degraded resourceType=%s revision=%d failedCommands=%d',
          event.resourceType,
          event.revision,
          failedCommands,
        );
        return;
      }
      log(
        'invalidation complete resourceType=%s revision=%d scopeCount=%d',
        event.resourceType,
        event.revision,
        scopes.length,
      );
    } catch (error) {
      // Best-effort: never break the publish path.
      log(
        'invalidation degraded resourceType=%s errorClass=%s',
        event.resourceType,
        getErrorClass(error),
      );
    }
  };
}

/** Redis-backed scope version reader used by the process-wide cache epoch helper. */
export class RedisPlatformConfigVersionReader implements PlatformConfigVersionReader {
  constructor(
    private readonly redisDependencies: PlatformConfigRedisDependencies = defaultRedisDependencies,
  ) {}

  getScopeVersion = async (scope: string): Promise<string> => {
    const [normalizedScope] = normalizeScopes([scope]);
    if (!normalizedScope) return '0';

    try {
      const config = this.redisDependencies.getRedisConfig();
      if (!config.enabled) return '0';
      const redis = await this.redisDependencies.initializeRedis(config);
      return (await redis?.get(platformConfigKeys.scopeVersion(normalizedScope))) ?? '0';
    } catch (error) {
      log('scope version read degraded errorClass=%s', getErrorClass(error));
      return '0';
    }
  };
}

let defaultPublisher: PlatformConfigInvalidationPublisher | null = null;

/**
 * Resolve the process-wide invalidation publisher.
 * Prefers Redis when enabled; falls back to in-memory for dev/tests.
 */
export const getPlatformConfigInvalidationPublisher = (): PlatformConfigInvalidationPublisher => {
  if (defaultPublisher) return defaultPublisher;

  try {
    if (getRedisConfig().enabled) {
      defaultPublisher = new RedisPlatformConfigInvalidationPublisher();
      return defaultPublisher;
    }
  } catch {
    // env not ready in some test contexts
  }

  defaultPublisher = new InMemoryPlatformConfigInvalidationPublisher();
  return defaultPublisher;
};

/** Test helper to inject a publisher. */
export const setPlatformConfigInvalidationPublisher = (
  publisher: PlatformConfigInvalidationPublisher | null,
): void => {
  defaultPublisher = publisher;
};

/**
 * Read a cross-instance cache epoch. Redis loss degrades to a process-local
 * epoch; consumers still apply a bounded TTL before rebuilding from the DB.
 */
export const getPlatformConfigScopeVersion = async (scope: string): Promise<string> => {
  const [normalizedScope] = normalizeScopes([scope]);
  if (!normalizedScope) return '0';

  const publisher = getPlatformConfigInvalidationPublisher();
  if ('getScopeVersion' in publisher) {
    return (publisher as PlatformConfigVersionReader).getScopeVersion(normalizedScope);
  }
  return new RedisPlatformConfigVersionReader().getScopeVersion(normalizedScope);
};
