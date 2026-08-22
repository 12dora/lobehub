import { isRecord, pickTrimmedString } from '@lobechat/utils/object';

import { getRedisConfig } from '@/envs/redis';
import { createRedisWithPrefix, isRedisEnabled } from '@/libs/redis/manager';
import type { BaseRedisProvider, RedisConfig } from '@/libs/redis/types';
import type {
  AdminSystemDocumentRenderHealth,
  AdminSystemSandboxHealth,
} from '@/server/enterprise/contracts/adminSystem';

import type { IdentityProviderStartupHealth } from '../identityProvider/startupArtifact';
import {
  PlatformSystemJobConflictError,
  PlatformSystemJobInvalidError,
  PlatformSystemJobNotFoundError,
} from './errors';
import type { DependencyHealth } from './infraDependencyConfig';
import { mailHealth } from './infraDependencyConfig';
import { probeLatencyMs } from './infraProbes';

export type { DependencyHealth };

export type DatabaseProbeResult = {
  latencyMs: number;
  version?: string;
};

export interface RedisHealthDependencies {
  createRedisWithPrefix: (config: RedisConfig, prefix: string) => Promise<BaseRedisProvider | null>;
  getRedisConfig: () => RedisConfig;
  isRedisEnabled: (config: RedisConfig) => boolean;
}

export const defaultRedisHealthDependencies: RedisHealthDependencies = {
  createRedisWithPrefix,
  getRedisConfig,
  isRedisEnabled,
};

export const parsePostgresVersion = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  const token =
    text.match(/PostgreSQL\s+(\d+(?:\.\d+)*)/i)?.[1] ?? text.match(/(\d+(?:\.\d+)*)/)?.[1];
  const version = token?.trim().slice(0, 64);
  return version || undefined;
};

export const extractSqlVersionText = (result: unknown): string | undefined => {
  const rows = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.rows)
      ? result.rows
      : undefined;
  const first = rows?.[0];
  if (!isRecord(first)) return undefined;
  return pickTrimmedString(first.version) ?? pickTrimmedString(Object.values(first)[0]);
};

export const disabledHealth = (): DependencyHealth => ({
  errorCategory: null,
  lastCheckedAt: null,
  status: 'disabled',
});

export const probeRedis = async (
  dependencies: RedisHealthDependencies,
): Promise<DependencyHealth> => {
  const config = dependencies.getRedisConfig();
  if (!dependencies.isRedisEnabled(config)) return disabledHealth();
  let client: BaseRedisProvider | null = null;
  const checkedAt = new Date();
  const startedAt = performance.now();
  try {
    client = await dependencies.createRedisWithPrefix(config, 'platformSystemHealth');
    if (!client) return disabledHealth();
    return {
      detail: 'Redis',
      errorCategory: null,
      lastCheckedAt: checkedAt,
      latencyMs: probeLatencyMs(startedAt),
      status: 'healthy',
    };
  } catch (error) {
    return {
      detail: 'Redis',
      errorCategory:
        error instanceof Error && /timeout/i.test(error.message)
          ? 'timeout'
          : 'operation_unavailable',
      lastCheckedAt: checkedAt,
      latencyMs: probeLatencyMs(startedAt),
      status: 'unavailable',
    };
  } finally {
    if (client) await client.disconnect();
  }
};

export const publicationDomains = {
  // 平台助理 de-drafted: `.save` is the live write, `.publish` is kept so historical
  // failures still roll up into publish health.
  'admin.agents.publish': 'agent_catalog',
  'admin.agents.save': 'agent_catalog',
  'admin.aiProviders.publish': 'ai_catalog',
  // 品牌自定义 de-drafted: `.save` is the live write, `.publish` is kept so historical
  // failures still roll up into publish health.
  'admin.branding.publish': 'branding',
  'admin.branding.save': 'branding',
  'admin.connectors.publish': 'connector_catalog',
  'admin.identityProviders.publish': 'identity',
  // 统一管理 de-drafted: `.save` is the live write, `.publish` is kept so historical
  // failures still roll up into publish health.
  'admin.managedResources.publish': 'managed_policy',
  'admin.managedResources.save': 'managed_policy',
  'admin.settings.publish': 'settings',
  'admin.settings.save': 'settings',
  'admin.skills.publish': 'skill_catalog',
} as const;

export const failureCategory = (value: unknown) => {
  if (typeof value !== 'string') return 'unknown' as const;
  if (value.includes('conflict')) return 'conflict' as const;
  if (value.includes('invalid') || value.includes('validation')) return 'validation' as const;
  if (value.includes('dependency')) return 'dependency_unavailable' as const;
  if (value.includes('unavailable') || value.includes('failed'))
    return 'operation_unavailable' as const;
  return 'unknown' as const;
};

export const mutationFailureCategory = (error: unknown): string => {
  if (error instanceof PlatformSystemJobNotFoundError) return 'not_found';
  if (error instanceof PlatformSystemJobConflictError) return 'revision_conflict';
  if (error instanceof PlatformSystemJobInvalidError) return 'invalid_input';
  return 'operation_unavailable';
};

export type PublishedSsoLookup = 'empty' | 'lookup_failed' | 'present';

export const projectOidcStatus = (params: {
  artifact: IdentityProviderStartupHealth | null;
  authSnapshot: { pendingRestart: boolean } | null;
  envSsoConfigured: boolean;
  flags: { ENABLE_DATABASE_OIDC: boolean };
  publishedSso: PublishedSsoLookup;
}) => {
  const { flags, artifact, authSnapshot, envSsoConfigured, publishedSso } = params;
  const configured =
    envSsoConfigured ||
    (artifact?.providerIds.length ?? 0) > 0 ||
    publishedSso === 'present' ||
    publishedSso === 'lookup_failed';
  // Fail closed: if the canonical ledger is unavailable, do not claim "active".
  const pendingRestart = authSnapshot
    ? authSnapshot.pendingRestart
    : Boolean(flags.ENABLE_DATABASE_OIDC && artifact);
  if (!flags.ENABLE_DATABASE_OIDC) {
    return envSsoConfigured
      ? ({
          activeRevision: null,
          configured: true,
          pendingRestart: false,
          source: 'environment',
          status: 'healthy',
        } as const)
      : ({
          activeRevision: null,
          configured: false,
          pendingRestart: false,
          source: 'disabled',
          status: 'disabled',
        } as const);
  }
  if (artifact) {
    return {
      activeRevision: artifact.identityRevision,
      configured,
      pendingRestart,
      source: artifact.source,
      // Prefer artifact health when the ledger is available; mark unavailable
      // when the canonical restart status could not be loaded or published
      // selection itself failed.
      status:
        publishedSso === 'lookup_failed' || !authSnapshot
          ? ('unavailable' as const)
          : artifact.health,
    } as const;
  }
  return {
    activeRevision: null,
    configured,
    pendingRestart: true,
    source: 'unknown',
    status: 'unavailable',
  } as const;
};

const withCheckedAt = (health: DependencyHealth, checkedAt: Date): DependencyHealth => ({
  ...health,
  lastCheckedAt:
    health.lastCheckedAt === undefined
      ? health.status === 'disabled' || health.errorCategory === 'configuration_incomplete'
        ? null
        : checkedAt
      : health.lastCheckedAt,
});

export const projectDependencies = (params: {
  checkedAt: Date;
  databaseResult: PromiseSettledResult<DatabaseProbeResult>;
  documentRender?: AdminSystemDocumentRenderHealth | null;
  env: Record<string, string | undefined>;
  keyManagement: DependencyHealth;
  objectStorage: DependencyHealth;
  redisResult: PromiseSettledResult<DependencyHealth>;
  sandbox?: AdminSystemSandboxHealth | null;
}) => {
  const {
    checkedAt,
    documentRender,
    env,
    databaseResult,
    keyManagement,
    objectStorage,
    redisResult,
    sandbox,
  } = params;
  return {
    database:
      databaseResult.status === 'fulfilled'
        ? ({
            detail: 'PostgreSQL',
            errorCategory: null,
            lastCheckedAt: checkedAt,
            latencyMs: databaseResult.value.latencyMs,
            status: 'healthy',
            ...(databaseResult.value.version ? { version: databaseResult.value.version } : {}),
          } as const)
        : ({
            detail: 'PostgreSQL',
            errorCategory: 'operation_unavailable',
            lastCheckedAt: checkedAt,
            status: 'unavailable',
          } as const),
    keyManagement: withCheckedAt(keyManagement, checkedAt),
    mail: mailHealth(env),
    objectStorage: withCheckedAt(objectStorage, checkedAt),
    redis:
      redisResult.status === 'fulfilled'
        ? withCheckedAt(redisResult.value, checkedAt)
        : ({
            errorCategory: 'operation_unavailable',
            lastCheckedAt: checkedAt,
            status: 'unavailable',
          } as const),
    ...(documentRender ? { documentRender } : {}),
    ...(sandbox ? { sandbox } : {}),
  };
};
