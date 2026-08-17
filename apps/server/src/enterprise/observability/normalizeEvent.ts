import {
  ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES,
  ENTERPRISE_CACHE_DOMAINS,
  ENTERPRISE_CACHE_EPOCH_OUTCOMES,
  ENTERPRISE_CACHE_LOAD_OUTCOMES,
  ENTERPRISE_CACHE_REQUEST_OUTCOMES,
  ENTERPRISE_CONFIG_DOMAINS,
  ENTERPRISE_CONFIG_PUBLISH_OPERATIONS,
  ENTERPRISE_CONFIG_PUBLISH_OUTCOMES,
  ENTERPRISE_GUARD_CLASSIFICATIONS,
  ENTERPRISE_GUARD_MODES,
  ENTERPRISE_GUARD_OUTCOMES,
  ENTERPRISE_GUARD_RESOURCES,
  ENTERPRISE_HEARTBEAT_OPERATIONS,
  ENTERPRISE_HEARTBEAT_OUTCOMES,
  ENTERPRISE_INVALIDATION_BACKENDS,
  ENTERPRISE_INVALIDATION_OUTCOMES,
  ENTERPRISE_OIDC_FAILURE_CATEGORIES,
  ENTERPRISE_OIDC_LOGIN_OUTCOMES,
  ENTERPRISE_OIDC_LOGIN_STAGES,
  ENTERPRISE_OPERATIONAL_COLLECTION_OUTCOMES,
  ENTERPRISE_OPERATIONAL_COLLECTORS,
  ENTERPRISE_SSRF_DENIAL_CATEGORIES,
} from '@lobechat/observability-otel/modules/enterprise-platform';

import type { EnterpriseObservabilityErrorClass, EnterpriseObservabilityEvent } from './types';

const ERROR_CLASSES = new Set([
  'ConflictError',
  'TimeoutError',
  'UnavailableError',
  'UnexpectedError',
  'ValidationError',
]);

const normalizedErrorClass = (
  errorClass: EnterpriseObservabilityErrorClass | undefined,
): EnterpriseObservabilityErrorClass | undefined =>
  errorClass && ERROR_CLASSES.has(errorClass)
    ? errorClass
    : errorClass
      ? 'UnexpectedError'
      : undefined;

const isClosedValue = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && allowed.includes(value as T);

const withErrorClass = (errorClass: EnterpriseObservabilityErrorClass | undefined) => {
  const c = normalizedErrorClass(errorClass);
  return c ? { errorClass: c } : {};
};

const normalizeConfigPublish = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'config_publish' }>,
): EnterpriseObservabilityEvent | null => {
  if (
    !isClosedValue(event.domain, ENTERPRISE_CONFIG_DOMAINS) ||
    !isClosedValue(event.operation, ENTERPRISE_CONFIG_PUBLISH_OPERATIONS) ||
    !isClosedValue(event.outcome, ENTERPRISE_CONFIG_PUBLISH_OUTCOMES)
  )
    return null;
  return {
    domain: event.domain,
    durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0,
    ...withErrorClass(event.errorClass),
    operation: event.operation,
    outcome: event.outcome,
    type: event.type,
  };
};

const normalizeInvalidation = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'invalidation' }>,
): EnterpriseObservabilityEvent | null => {
  if (
    !isClosedValue(event.backend, ENTERPRISE_INVALIDATION_BACKENDS) ||
    !isClosedValue(event.outcome, ENTERPRISE_INVALIDATION_OUTCOMES)
  )
    return null;
  return {
    backend: event.backend,
    ...withErrorClass(event.errorClass),
    outcome: event.outcome,
    type: event.type,
  };
};

const normalizeCache = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'cache' }>,
): EnterpriseObservabilityEvent | null => {
  if (!isClosedValue(event.domain, ENTERPRISE_CACHE_DOMAINS)) return null;
  if (event.operation === 'load') {
    if (!isClosedValue(event.outcome, ENTERPRISE_CACHE_LOAD_OUTCOMES)) return null;
    return {
      domain: event.domain,
      ...withErrorClass(event.errorClass),
      operation: event.operation,
      outcome: event.outcome,
      type: event.type,
    };
  }
  if (event.operation === 'epoch') {
    if (!isClosedValue(event.outcome, ENTERPRISE_CACHE_EPOCH_OUTCOMES)) return null;
    return {
      domain: event.domain,
      operation: event.operation,
      outcome: event.outcome,
      type: event.type,
    };
  }
  if (
    event.operation !== 'request' ||
    !isClosedValue(event.outcome, ENTERPRISE_CACHE_REQUEST_OUTCOMES)
  )
    return null;
  return {
    domain: event.domain,
    operation: event.operation,
    outcome: event.outcome,
    type: event.type,
  };
};

const normalizeGuardDecision = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'guard_decision' }>,
): EnterpriseObservabilityEvent | null => {
  if (
    !isClosedValue(event.classification, ENTERPRISE_GUARD_CLASSIFICATIONS) ||
    !isClosedValue(event.mode, ENTERPRISE_GUARD_MODES) ||
    !isClosedValue(event.outcome, ENTERPRISE_GUARD_OUTCOMES) ||
    !isClosedValue(event.resource, ENTERPRISE_GUARD_RESOURCES)
  )
    return null;
  return {
    classification: event.classification,
    mode: event.mode,
    outcome: event.outcome,
    resource: event.resource,
    type: event.type,
  };
};

const normalizeInstanceHeartbeat = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'instance_heartbeat' }>,
): EnterpriseObservabilityEvent | null => {
  if (
    !isClosedValue(event.operation, ENTERPRISE_HEARTBEAT_OPERATIONS) ||
    !isClosedValue(event.outcome, ENTERPRISE_HEARTBEAT_OUTCOMES)
  )
    return null;
  return {
    durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0,
    ...withErrorClass(event.errorClass),
    operation: event.operation,
    outcome: event.outcome,
    type: event.type,
  };
};

const normalizeSsrfDenial = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'ssrf_denial' }>,
): EnterpriseObservabilityEvent | null => {
  if (!isClosedValue(event.category, ENTERPRISE_SSRF_DENIAL_CATEGORIES)) return null;
  return { category: event.category, type: event.type };
};

const normalizeOidcLogin = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'oidc_login' }>,
): EnterpriseObservabilityEvent | null => {
  if (
    !isClosedValue(event.stage, ENTERPRISE_OIDC_LOGIN_STAGES) ||
    !isClosedValue(event.outcome, ENTERPRISE_OIDC_LOGIN_OUTCOMES)
  )
    return null;
  if (event.outcome === 'failure') {
    if (!isClosedValue(event.failureCategory, ENTERPRISE_OIDC_FAILURE_CATEGORIES)) return null;
    return {
      failureCategory: event.failureCategory,
      outcome: event.outcome,
      stage: event.stage,
      type: event.type,
    };
  }
  return { outcome: event.outcome, stage: event.stage, type: event.type };
};

const normalizeAgentMaterialization = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'agent_materialization' }>,
): EnterpriseObservabilityEvent | null => {
  if (!isClosedValue(event.outcome, ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES)) return null;
  return {
    durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0,
    outcome: event.outcome,
    type: event.type,
  };
};

const normalizeOperationalCollection = (
  event: Extract<EnterpriseObservabilityEvent, { type: 'operational_collection' }>,
): EnterpriseObservabilityEvent | null => {
  if (
    !isClosedValue(event.collector, ENTERPRISE_OPERATIONAL_COLLECTORS) ||
    !isClosedValue(event.outcome, ENTERPRISE_OPERATIONAL_COLLECTION_OUTCOMES)
  )
    return null;
  return {
    collector: event.collector,
    durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0,
    ...withErrorClass(event.errorClass),
    outcome: event.outcome,
    type: event.type,
  };
};

export const normalizeEvent = (
  event: EnterpriseObservabilityEvent,
): EnterpriseObservabilityEvent | null => {
  switch (event.type) {
    case 'config_publish': {
      return normalizeConfigPublish(event);
    }
    case 'invalidation': {
      return normalizeInvalidation(event);
    }
    case 'cache': {
      return normalizeCache(event);
    }
    case 'guard_decision': {
      return normalizeGuardDecision(event);
    }
    case 'instance_heartbeat': {
      return normalizeInstanceHeartbeat(event);
    }
    case 'ssrf_denial': {
      return normalizeSsrfDenial(event);
    }
    case 'oidc_login': {
      return normalizeOidcLogin(event);
    }
    case 'agent_materialization': {
      return normalizeAgentMaterialization(event);
    }
    case 'operational_collection': {
      return normalizeOperationalCollection(event);
    }
  }
};
