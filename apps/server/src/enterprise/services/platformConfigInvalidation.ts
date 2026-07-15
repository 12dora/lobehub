import debug from 'debug';

import type { PlatformResourceType } from '@/database/schemas/platform';
import { getRedisConfig } from '@/envs/redis';
import { initializeRedis } from '@/libs/redis';

const log = debug('lobe-server:platform-config-invalidation');

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
export class InMemoryPlatformConfigInvalidationPublisher implements PlatformConfigInvalidationPublisher {
  readonly events: PlatformConfigInvalidationEvent[] = [];
  readonly versions = new Map<string, number>();

  publish = async (event: PlatformConfigInvalidationEvent): Promise<void> => {
    this.events.push(event);
    this.versions.set(`${event.resourceType}:${event.resourceId}`, event.revision);
    this.versions.set('global', event.revision);
    for (const scope of event.scopes ?? []) {
      this.versions.set(`scope:${scope}`, event.revision);
    }
  };
}

/**
 * Best-effort Redis version-key publisher.
 * Failures are logged and swallowed so publish transactions are not rolled back.
 */
export class RedisPlatformConfigInvalidationPublisher implements PlatformConfigInvalidationPublisher {
  publish = async (event: PlatformConfigInvalidationEvent): Promise<void> => {
    try {
      if (!getRedisConfig().enabled) {
        log('redis disabled; skip invalidation for %s:%s', event.resourceType, event.resourceId);
        return;
      }

      const redis = await initializeRedis(getRedisConfig());
      if (!redis) {
        log('redis unavailable; skip invalidation for %s:%s', event.resourceType, event.resourceId);
        return;
      }

      const pipeline = redis.pipeline();
      pipeline.set(platformConfigKeys.globalVersion(), String(event.revision));
      pipeline.set(
        platformConfigKeys.resourceVersion(event.resourceType, event.resourceId),
        String(event.revision),
      );
      for (const scope of event.scopes ?? []) {
        pipeline.set(platformConfigKeys.scopeVersion(scope), String(event.revision));
      }
      // Store a small envelope for diagnostics / multi-instance watchers.
      pipeline.set(
        `platform:config:last_event:${event.resourceType}:${event.resourceId}`,
        JSON.stringify(event),
      );
      await pipeline.exec();
      log(
        'invalidated %s:%s revision=%d scopes=%o',
        event.resourceType,
        event.resourceId,
        event.revision,
        event.scopes,
      );
    } catch (error) {
      // Best-effort: never break the publish path.
      log('invalidation failed for %s:%s %O', event.resourceType, event.resourceId, error);
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
