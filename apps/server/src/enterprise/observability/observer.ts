import {
  recordCacheEpochMetric,
  recordCacheLoadMetric,
  recordCacheRequestMetric,
  recordConfigPublishMetric,
  recordGuardDecisionMetric,
  recordHeartbeatMetric,
  recordInvalidationMetric,
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

const normalizeEvent = (event: EnterpriseObservabilityEvent): EnterpriseObservabilityEvent => {
  switch (event.type) {
    case 'config_publish': {
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
      if (event.operation === 'load') {
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
        return {
          domain: event.domain,
          operation: event.operation,
          outcome: event.outcome,
          type: event.type,
        };
      }
      return {
        domain: event.domain,
        operation: event.operation,
        outcome: event.outcome,
        type: event.type,
      };
    }
    case 'guard_decision': {
      return {
        classification: event.classification,
        mode: event.mode,
        outcome: event.outcome,
        resource: event.resource,
        type: event.type,
      };
    }
    case 'instance_heartbeat': {
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
