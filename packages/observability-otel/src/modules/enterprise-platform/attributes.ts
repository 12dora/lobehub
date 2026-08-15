import type { Attributes } from '@opentelemetry/api';

export const ENTERPRISE_CONFIG_DOMAINS = [
  'agent_catalog',
  'ai_catalog',
  'branding',
  'connector_catalog',
  'identity',
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
export const ENTERPRISE_SSRF_DENIAL_CATEGORIES = [
  'invalid_url',
  'protocol_denied',
  'credential_url',
  'metadata_endpoint',
  'allowlist_denied',
  'invalid_address',
  'non_public_address',
  'dns_unavailable',
  'policy_changed',
  'policy_unavailable',
  'secret_redirect',
  'redirect_limit',
  'deadline_exceeded',
] as const;
export const ENTERPRISE_OIDC_LOGIN_STAGES = [
  'token_exchange',
  'state_validation',
  'id_token_verification',
  'userinfo',
  'authenticated',
] as const;
export const ENTERPRISE_OIDC_LOGIN_OUTCOMES = ['success', 'failure'] as const;
export const ENTERPRISE_OIDC_FAILURE_CATEGORIES = [
  'state_invalid',
  'token_invalid',
  'nonce_invalid',
  'id_token_invalid',
  'userinfo_invalid',
  'subject_mismatch',
  'claim_invalid',
  'network_failure',
  'unexpected',
] as const;
export const ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES = [
  'created',
  'reused',
  'race_reused',
  'archived',
  'failure',
] as const;
/**
 * Closed publication vocabulary. `save` is the de-drafted single write (append an immutable
 * version + move the published pointer in one transaction); `publish` stays for domains that
 * still promote a stored draft, `rollback` for pointer moves onto an older version.
 */
export const ENTERPRISE_CONFIG_PUBLISH_OPERATIONS = ['publish', 'rollback', 'save'] as const;
export const ENTERPRISE_CONFIG_PUBLISH_OUTCOMES = ['conflict', 'failure', 'success'] as const;
export const ENTERPRISE_INVALIDATION_BACKENDS = ['memory', 'redis'] as const;
export const ENTERPRISE_INVALIDATION_OUTCOMES = [
  'disabled',
  'error',
  'partial_failure',
  'success',
  'unavailable',
] as const;
export const ENTERPRISE_CACHE_REQUEST_OUTCOMES = ['coalesced', 'hit', 'negative'] as const;
export const ENTERPRISE_CACHE_LOAD_OUTCOMES = [
  'load_failure',
  'loaded',
  'loaded_negative',
] as const;
export const ENTERPRISE_CACHE_EPOCH_OUTCOMES = ['changed', 'failure', 'success'] as const;
export const ENTERPRISE_GUARD_CLASSIFICATIONS = ['deny', 'input-sensitive'] as const;
export const ENTERPRISE_GUARD_MODES = ['enforced', 'observe', 'ui-only'] as const;
export const ENTERPRISE_GUARD_OUTCOMES = ['catalog_not_ready', 'denied', 'would_deny'] as const;
export const ENTERPRISE_HEARTBEAT_OPERATIONS = ['register', 'tick'] as const;
export const ENTERPRISE_HEARTBEAT_OUTCOMES = ['failure', 'success'] as const;
export const ENTERPRISE_JOB_BACKLOG_STATES = [
  'pending',
  'reserved_expired',
  'running_lease_expired',
] as const;
export const ENTERPRISE_OPERATIONAL_COLLECTORS = ['job_backlog', 'revision_lag'] as const;
export const ENTERPRISE_OPERATIONAL_COLLECTION_OUTCOMES = ['failure', 'success'] as const;
export const ENTERPRISE_REVISION_LAG_DOMAINS = ['identity'] as const;
export const ENTERPRISE_REVISION_LAG_REASONS = ['degraded', 'diverged'] as const;

export type EnterpriseCacheDomain = (typeof ENTERPRISE_CACHE_DOMAINS)[number];
export type EnterpriseCacheEpochOutcome = (typeof ENTERPRISE_CACHE_EPOCH_OUTCOMES)[number];
export type EnterpriseCacheLoadOutcome = (typeof ENTERPRISE_CACHE_LOAD_OUTCOMES)[number];
export type EnterpriseCacheRequestOutcome = (typeof ENTERPRISE_CACHE_REQUEST_OUTCOMES)[number];
export type EnterpriseConfigDomain = (typeof ENTERPRISE_CONFIG_DOMAINS)[number];
export type EnterpriseConfigPublishOperation =
  (typeof ENTERPRISE_CONFIG_PUBLISH_OPERATIONS)[number];
export type EnterpriseConfigPublishOutcome = (typeof ENTERPRISE_CONFIG_PUBLISH_OUTCOMES)[number];
export type EnterpriseGuardClassification = (typeof ENTERPRISE_GUARD_CLASSIFICATIONS)[number];
export type EnterpriseGuardMode = (typeof ENTERPRISE_GUARD_MODES)[number];
export type EnterpriseGuardOutcome = (typeof ENTERPRISE_GUARD_OUTCOMES)[number];
export type EnterpriseGuardResource = (typeof ENTERPRISE_GUARD_RESOURCES)[number];
export type EnterpriseHeartbeatOperation = (typeof ENTERPRISE_HEARTBEAT_OPERATIONS)[number];
export type EnterpriseHeartbeatOutcome = (typeof ENTERPRISE_HEARTBEAT_OUTCOMES)[number];
export type EnterpriseInvalidationBackend = (typeof ENTERPRISE_INVALIDATION_BACKENDS)[number];
export type EnterpriseInvalidationOutcome = (typeof ENTERPRISE_INVALIDATION_OUTCOMES)[number];
export type EnterpriseJobBacklogState = (typeof ENTERPRISE_JOB_BACKLOG_STATES)[number];
export type EnterpriseOperationalCollector = (typeof ENTERPRISE_OPERATIONAL_COLLECTORS)[number];
export type EnterpriseOperationalCollectionOutcome =
  (typeof ENTERPRISE_OPERATIONAL_COLLECTION_OUTCOMES)[number];
export type EnterpriseRevisionLagDomain = (typeof ENTERPRISE_REVISION_LAG_DOMAINS)[number];
export type EnterpriseRevisionLagReason = (typeof ENTERPRISE_REVISION_LAG_REASONS)[number];
export type EnterpriseSsrfDenialCategory = (typeof ENTERPRISE_SSRF_DENIAL_CATEGORIES)[number];
export type EnterpriseOidcLoginStage = (typeof ENTERPRISE_OIDC_LOGIN_STAGES)[number];
export type EnterpriseOidcLoginOutcome = (typeof ENTERPRISE_OIDC_LOGIN_OUTCOMES)[number];
export type EnterpriseOidcFailureCategory = (typeof ENTERPRISE_OIDC_FAILURE_CATEGORIES)[number];
export type EnterpriseAgentMaterializationOutcome =
  (typeof ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES)[number];

const closedValue = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && allowed.includes(value as T) ? (value as T) : undefined;

const compact = (input: Record<string, string | undefined>): Attributes =>
  Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => !!entry[1]),
  );

export interface ConfigPublishMetricAttributes {
  domain: EnterpriseConfigDomain;
  operation: EnterpriseConfigPublishOperation;
  outcome: EnterpriseConfigPublishOutcome;
}

export const buildConfigPublishAttributes = (input: ConfigPublishMetricAttributes): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_CONFIG_DOMAINS),
    'enterprise.operation': closedValue(input.operation, ENTERPRISE_CONFIG_PUBLISH_OPERATIONS),
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_CONFIG_PUBLISH_OUTCOMES),
  });

export interface InvalidationMetricAttributes {
  backend: EnterpriseInvalidationBackend;
  outcome: EnterpriseInvalidationOutcome;
}

export const buildInvalidationAttributes = (input: InvalidationMetricAttributes): Attributes =>
  compact({
    'enterprise.backend': closedValue(input.backend, ENTERPRISE_INVALIDATION_BACKENDS),
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_INVALIDATION_OUTCOMES),
  });

export const buildCacheRequestAttributes = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheRequestOutcome;
}): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_CACHE_DOMAINS),
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_CACHE_REQUEST_OUTCOMES),
  });

export const buildCacheLoadAttributes = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheLoadOutcome;
}): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_CACHE_DOMAINS),
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_CACHE_LOAD_OUTCOMES),
  });

export const buildCacheEpochAttributes = (input: {
  domain: EnterpriseCacheDomain;
  outcome: EnterpriseCacheEpochOutcome;
}): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_CACHE_DOMAINS),
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_CACHE_EPOCH_OUTCOMES),
  });

export interface GuardDecisionMetricAttributes {
  classification: EnterpriseGuardClassification;
  mode: EnterpriseGuardMode;
  outcome: EnterpriseGuardOutcome;
  resource: EnterpriseGuardResource;
}

export const buildGuardDecisionAttributes = (input: GuardDecisionMetricAttributes): Attributes =>
  compact({
    'enterprise.classification': closedValue(
      input.classification,
      ENTERPRISE_GUARD_CLASSIFICATIONS,
    ),
    'enterprise.mode': closedValue(input.mode, ENTERPRISE_GUARD_MODES),
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_GUARD_OUTCOMES),
    'enterprise.resource': closedValue(input.resource, ENTERPRISE_GUARD_RESOURCES),
  });

export interface HeartbeatMetricAttributes {
  operation: EnterpriseHeartbeatOperation;
  outcome: EnterpriseHeartbeatOutcome;
}

export const buildHeartbeatAttributes = (input: HeartbeatMetricAttributes): Attributes =>
  compact({
    'enterprise.operation': closedValue(input.operation, ENTERPRISE_HEARTBEAT_OPERATIONS),
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_HEARTBEAT_OUTCOMES),
  });

export interface SsrfDenialMetricAttributes {
  category: EnterpriseSsrfDenialCategory;
}

export const buildSsrfDenialAttributes = (input: SsrfDenialMetricAttributes): Attributes =>
  compact({
    'enterprise.category': closedValue(input.category, ENTERPRISE_SSRF_DENIAL_CATEGORIES),
  });

export type OidcLoginMetricAttributes =
  | {
      outcome: 'success';
      stage: EnterpriseOidcLoginStage;
    }
  | {
      failureCategory: EnterpriseOidcFailureCategory;
      outcome: 'failure';
      stage: EnterpriseOidcLoginStage;
    };

export const buildOidcLoginAttributes = (input: OidcLoginMetricAttributes): Attributes => {
  const outcome = closedValue(input.outcome, ENTERPRISE_OIDC_LOGIN_OUTCOMES);
  const stage = closedValue(input.stage, ENTERPRISE_OIDC_LOGIN_STAGES);
  if (!outcome || !stage) return {};

  if (input.outcome === 'failure') {
    return {
      'enterprise.failure_category':
        closedValue(input.failureCategory, ENTERPRISE_OIDC_FAILURE_CATEGORIES) ?? 'unexpected',
      'enterprise.outcome': outcome,
      'enterprise.stage': stage,
    };
  }

  return { 'enterprise.outcome': outcome, 'enterprise.stage': stage };
};

export interface AgentMaterializationMetricAttributes {
  outcome: EnterpriseAgentMaterializationOutcome;
}

export const buildAgentMaterializationAttributes = (
  input: AgentMaterializationMetricAttributes,
): Attributes =>
  compact({
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES),
  });

export interface JobBacklogMetricAttributes {
  state: EnterpriseJobBacklogState;
}

export const buildJobBacklogAttributes = (input: JobBacklogMetricAttributes): Attributes =>
  compact({
    'enterprise.scope': 'cluster',
    'enterprise.state': closedValue(input.state, ENTERPRISE_JOB_BACKLOG_STATES),
  });

export interface OperationalCollectionMetricAttributes {
  collector: EnterpriseOperationalCollector;
  outcome: EnterpriseOperationalCollectionOutcome;
}

export const buildOperationalCollectionAttributes = (
  input: OperationalCollectionMetricAttributes,
): Attributes =>
  compact({
    'enterprise.collector': closedValue(input.collector, ENTERPRISE_OPERATIONAL_COLLECTORS),
    'enterprise.outcome': closedValue(input.outcome, ENTERPRISE_OPERATIONAL_COLLECTION_OUTCOMES),
    'enterprise.scope': 'cluster',
  });

export const buildOperationalCollectorAttributes = (input: {
  collector: EnterpriseOperationalCollector;
}): Attributes =>
  compact({
    'enterprise.collector': closedValue(input.collector, ENTERPRISE_OPERATIONAL_COLLECTORS),
    'enterprise.scope': 'cluster',
  });

export const buildRevisionLagAttributes = (input: {
  domain: EnterpriseRevisionLagDomain;
  reason: EnterpriseRevisionLagReason;
}): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_REVISION_LAG_DOMAINS),
    'enterprise.reason': closedValue(input.reason, ENTERPRISE_REVISION_LAG_REASONS),
    'enterprise.scope': 'cluster',
  });

export const buildRevisionFreshAttributes = (input: {
  domain: EnterpriseRevisionLagDomain;
}): Attributes =>
  compact({
    'enterprise.domain': closedValue(input.domain, ENTERPRISE_REVISION_LAG_DOMAINS),
    'enterprise.scope': 'cluster',
  });
