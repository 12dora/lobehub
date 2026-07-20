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
  recordAgentMaterializationMetric,
  recordCacheEpochMetric,
  recordCacheLoadMetric,
  recordCacheRequestMetric,
  recordConfigPublishMetric,
  recordGuardDecisionMetric,
  recordHeartbeatMetric,
  recordInvalidationMetric,
  recordOidcLoginMetric,
  recordOperationalCollectionMetric,
  recordSsrfDenialMetric,
} from '@lobechat/observability-otel/modules/enterprise-platform';

import { logEnterpriseObservation } from './structuredLogger';
import type { EnterpriseObservabilityErrorClass, EnterpriseObservabilityEvent } from './types';
import { classifyEnterpriseError } from './types';

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

const normalizeEvent = (
  event: EnterpriseObservabilityEvent,
): EnterpriseObservabilityEvent | null => {
  switch (event.type) {
    case 'config_publish': {
      if (
        !isClosedValue(event.domain, ENTERPRISE_CONFIG_DOMAINS) ||
        !isClosedValue(event.operation, ENTERPRISE_CONFIG_PUBLISH_OPERATIONS) ||
        !isClosedValue(event.outcome, ENTERPRISE_CONFIG_PUBLISH_OUTCOMES)
      )
        return null;
      return {
        domain: event.domain,
        durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0,
        ...(normalizedErrorClass(event.errorClass)
          ? { errorClass: normalizedErrorClass(event.errorClass) }
          : {}),
        operation: event.operation,
        outcome: event.outcome,
        type: event.type,
      };
    }
    case 'invalidation': {
      if (
        !isClosedValue(event.backend, ENTERPRISE_INVALIDATION_BACKENDS) ||
        !isClosedValue(event.outcome, ENTERPRISE_INVALIDATION_OUTCOMES)
      )
        return null;
      return {
        backend: event.backend,
        ...(normalizedErrorClass(event.errorClass)
          ? { errorClass: normalizedErrorClass(event.errorClass) }
          : {}),
        outcome: event.outcome,
        type: event.type,
      };
    }
    case 'cache': {
      if (!isClosedValue(event.domain, ENTERPRISE_CACHE_DOMAINS)) return null;
      if (event.operation === 'load') {
        if (!isClosedValue(event.outcome, ENTERPRISE_CACHE_LOAD_OUTCOMES)) return null;
        return {
          domain: event.domain,
          ...(normalizedErrorClass(event.errorClass)
            ? { errorClass: normalizedErrorClass(event.errorClass) }
            : {}),
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
    }
    case 'guard_decision': {
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
    }
    case 'instance_heartbeat': {
      if (
        !isClosedValue(event.operation, ENTERPRISE_HEARTBEAT_OPERATIONS) ||
        !isClosedValue(event.outcome, ENTERPRISE_HEARTBEAT_OUTCOMES)
      )
        return null;
      return {
        durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0,
        ...(normalizedErrorClass(event.errorClass)
          ? { errorClass: normalizedErrorClass(event.errorClass) }
          : {}),
        operation: event.operation,
        outcome: event.outcome,
        type: event.type,
      };
    }
    case 'ssrf_denial': {
      if (!isClosedValue(event.category, ENTERPRISE_SSRF_DENIAL_CATEGORIES)) return null;
      return { category: event.category, type: event.type };
    }
    case 'oidc_login': {
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
    }
    case 'agent_materialization': {
      if (!isClosedValue(event.outcome, ENTERPRISE_AGENT_MATERIALIZATION_OUTCOMES)) return null;
      return {
        durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0,
        outcome: event.outcome,
        type: event.type,
      };
    }
    case 'operational_collection': {
      if (
        !isClosedValue(event.collector, ENTERPRISE_OPERATIONAL_COLLECTORS) ||
        !isClosedValue(event.outcome, ENTERPRISE_OPERATIONAL_COLLECTION_OUTCOMES)
      )
        return null;
      return {
        collector: event.collector,
        durationMs: Number.isFinite(event.durationMs) ? Math.max(0, event.durationMs) : 0,
        ...(normalizedErrorClass(event.errorClass)
          ? { errorClass: normalizedErrorClass(event.errorClass) }
          : {}),
        outcome: event.outcome,
        type: event.type,
      };
    }
  }
};

export interface EnterprisePlatformObserver {
  record: (event: EnterpriseObservabilityEvent) => void;
}

export const NOOP_ENTERPRISE_PLATFORM_OBSERVER: EnterprisePlatformObserver = {
  record: () => {},
};

export class OpenTelemetryEnterprisePlatformObserver implements EnterprisePlatformObserver {
  record = (event: EnterpriseObservabilityEvent): void => {
    switch (event.type) {
      case 'config_publish': {
        recordConfigPublishMetric(event);
        return;
      }
      case 'invalidation': {
        recordInvalidationMetric(event);
        return;
      }
      case 'cache': {
        if (event.operation === 'request') recordCacheRequestMetric(event);
        else if (event.operation === 'load') recordCacheLoadMetric(event);
        else recordCacheEpochMetric(event);
        return;
      }
      case 'guard_decision': {
        recordGuardDecisionMetric(event);
        return;
      }
      case 'instance_heartbeat': {
        recordHeartbeatMetric(event);
        return;
      }
      case 'ssrf_denial': {
        recordSsrfDenialMetric(event);
        return;
      }
      case 'oidc_login': {
        recordOidcLoginMetric(event);
        return;
      }
      case 'agent_materialization': {
        recordAgentMaterializationMetric(event);
        return;
      }
      case 'operational_collection': {
        recordOperationalCollectionMetric(event);
      }
    }
  };
}

const defaultObserver = new OpenTelemetryEnterprisePlatformObserver();
let injectedObserver: EnterprisePlatformObserver | null = null;

export const getEnterprisePlatformObserver = (): EnterprisePlatformObserver =>
  injectedObserver ?? defaultObserver;

export const observeEnterprisePlatformEvent = (event: EnterpriseObservabilityEvent): void => {
  const normalized = normalizeEvent(event);
  if (!normalized) return;
  try {
    getEnterprisePlatformObserver().record(normalized);
  } catch (error) {
    console.error('[enterprise-observability] metric sink failed', {
      errorClass: classifyEnterpriseError(error),
    });
  }
  try {
    logEnterpriseObservation(normalized);
  } catch (error) {
    console.error('[enterprise-observability] log sink failed', {
      errorClass: classifyEnterpriseError(error),
    });
  }
};

export const setEnterprisePlatformObserverForTest = (
  observer: EnterprisePlatformObserver | null,
): void => {
  injectedObserver = observer;
};
