import {
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

import { normalizeEvent } from './normalizeEvent';
import { logEnterpriseObservation } from './structuredLogger';
import type { EnterpriseObservabilityEvent } from './types';
import { classifyEnterpriseError } from './types';

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
