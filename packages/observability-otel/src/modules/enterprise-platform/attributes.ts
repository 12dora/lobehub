import type { Attributes } from '@opentelemetry/api';

export const ENTERPRISE_CONFIG_DOMAINS = [
  'agent_catalog',
  'ai_catalog',
  'branding',
  'connector_catalog',
  'managed_resource',
  'settings',
  'skill_catalog',
  'unknown',
] as const;
export const ENTERPRISE_CACHE_DOMAINS = ['branding', 'skill_catalog'] as const;
export const ENTERPRISE_GUARD_RESOURCES = [
  'agents',
  'aiModels',
  'aiProviders',
  'connectors',
  'skills',
] as const;

export type EnterpriseCacheDomain = (typeof ENTERPRISE_CACHE_DOMAINS)[number];
export type EnterpriseCacheEpochOutcome = 'changed' | 'failure' | 'success';
export type EnterpriseCacheLoadOutcome = 'load_failure' | 'loaded' | 'loaded_negative';
export type EnterpriseCacheRequestOutcome = 'coalesced' | 'hit' | 'negative';
export type EnterpriseConfigDomain = (typeof ENTERPRISE_CONFIG_DOMAINS)[number];
export type EnterpriseConfigPublishOperation = 'publish' | 'rollback';
export type EnterpriseConfigPublishOutcome = 'conflict' | 'failure' | 'success';
export type EnterpriseGuardClassification = 'deny' | 'input-sensitive';
export type EnterpriseGuardMode = 'enforced' | 'observe' | 'ui-only';
export type EnterpriseGuardOutcome = 'catalog_not_ready' | 'denied' | 'would_deny';
export type EnterpriseGuardResource = (typeof ENTERPRISE_GUARD_RESOURCES)[number];
export type EnterpriseHeartbeatOperation = 'register' | 'tick';
export type EnterpriseHeartbeatOutcome = 'failure' | 'success';
export type EnterpriseInvalidationBackend = 'memory' | 'redis';
export type EnterpriseInvalidationOutcome =
  'disabled' | 'error' | 'partial_failure' | 'success' | 'unavailable';

const closedValue = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;

const compact = (input: Record<string, string | undefined>): Attributes =>
  Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => !!entry[1]),
  );

const CONFIG_PUBLISH_OPERATIONS = ['publish', 'rollback'] as const;
const CONFIG_PUBLISH_OUTCOMES = ['conflict', 'failure', 'success'] as const;
const INVALIDATION_BACKENDS = ['memory', 'redis'] as const;
const INVALIDATION_OUTCOMES = [
  'disabled',
  'error',
  'partial_failure',
  'success',
  'unavailable',
] as const;
const CACHE_REQUEST_OUTCOMES = ['coalesced', 'hit', 'negative'] as const;
const CACHE_LOAD_OUTCOMES = ['load_failure', 'loaded', 'loaded_negative'] as const;
const CACHE_EPOCH_OUTCOMES = ['changed', 'failure', 'success'] as const;
const GUARD_CLASSIFICATIONS = ['deny', 'input-sensitive'] as const;
const GUARD_MODES = ['enforced', 'observe', 'ui-only'] as const;
const GUARD_OUTCOMES = ['catalog_not_ready', 'denied', 'would_deny'] as const;
const HEARTBEAT_OPERATIONS = ['register', 'tick'] as const;
const HEARTBEAT_OUTCOMES = ['failure', 'success'] as const;

export interface ConfigPublishMetricAttributes {
  domain: EnterpriseConfigDomain;
  operation: EnterpriseConfigPublishOperation;
  outcome: EnterpriseConfigPublishOutcome;
}

export const buildConfigPublishAttributes = (input: ConfigPublishMetricAttributes): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_CONFIG_DOMAINS),
    'enterprise.operation': closedValue(input.operation, CONFIG_PUBLISH_OPERATIONS),
    'enterprise.outcome': closedValue(input.outcome, CONFIG_PUBLISH_OUTCOMES),
  });

export interface InvalidationMetricAttributes {
  backend: EnterpriseInvalidationBackend;
  outcome: EnterpriseInvalidationOutcome;
}

export const buildInvalidationAttributes = (input: InvalidationMetricAttributes): Attributes =>
  compact({
    'enterprise.backend': closedValue(input.backend, INVALIDATION_BACKENDS),
    'enterprise.outcome': closedValue(input.outcome, INVALIDATION_OUTCOMES),
  });

export const buildCacheRequestAttributes = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheRequestOutcome;
}): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_CACHE_DOMAINS),
    'enterprise.outcome': closedValue(input.outcome, CACHE_REQUEST_OUTCOMES),
  });

export const buildCacheLoadAttributes = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheLoadOutcome;
}): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_CACHE_DOMAINS),
    'enterprise.outcome': closedValue(input.outcome, CACHE_LOAD_OUTCOMES),
  });

export const buildCacheEpochAttributes = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheEpochOutcome;
}): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_CACHE_DOMAINS),
    'enterprise.outcome': closedValue(input.outcome, CACHE_EPOCH_OUTCOMES),
  });

export interface GuardDecisionMetricAttributes {
  classification: EnterpriseGuardClassification;
  mode: EnterpriseGuardMode;
  outcome: EnterpriseGuardOutcome;
  resource: EnterpriseGuardResource;
}

export const buildGuardDecisionAttributes = (input: GuardDecisionMetricAttributes): Attributes =>
  compact({
    'enterprise.classification': closedValue(input.classification, GUARD_CLASSIFICATIONS),
    'enterprise.mode': closedValue(input.mode, GUARD_MODES),
    'enterprise.outcome': closedValue(input.outcome, GUARD_OUTCOMES),
    'enterprise.resource': closedValue(input.resource, ENTERPRISE_GUARD_RESOURCES),
  });

export interface HeartbeatMetricAttributes {
  operation: EnterpriseHeartbeatOperation;
  outcome: EnterpriseHeartbeatOutcome;
}

export const buildHeartbeatAttributes = (input: HeartbeatMetricAttributes): Attributes =>
  compact({
    'enterprise.operation': closedValue(input.operation, HEARTBEAT_OPERATIONS),
    'enterprise.outcome': closedValue(input.outcome, HEARTBEAT_OUTCOMES),
  });
