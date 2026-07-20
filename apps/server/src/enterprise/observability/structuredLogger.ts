import debug from 'debug';

import { redactForLog } from '../security/redaction';
import type { EnterpriseObservabilityEvent } from './types';

const debugLog = debug('lobe-server:enterprise-observability');

export interface EnterpriseStructuredLogger {
  log: (event: EnterpriseObservabilityEvent) => void;
}

const shouldLog = (event: EnterpriseObservabilityEvent): boolean => {
  switch (event.type) {
    case 'config_publish': {
      return event.outcome !== 'success';
    }
    case 'invalidation': {
      return event.outcome !== 'success';
    }
    case 'cache': {
      return (
        (event.operation === 'load' && event.outcome === 'load_failure') ||
        (event.operation === 'epoch' && event.outcome === 'failure')
      );
    }
    case 'guard_decision': {
      return event.outcome === 'catalog_not_ready';
    }
    case 'instance_heartbeat': {
      return event.outcome === 'failure';
    }
  }
};

export const NOOP_ENTERPRISE_STRUCTURED_LOGGER: EnterpriseStructuredLogger = { log: () => {} };

const defaultLogger: EnterpriseStructuredLogger = {
  log: (event) => {
    if (!shouldLog(event)) return;
    debugLog('enterprise event %O', redactForLog(event));
  },
};

let injectedLogger: EnterpriseStructuredLogger | null = null;

export const logEnterpriseObservation = (event: EnterpriseObservabilityEvent): void =>
  (injectedLogger ?? defaultLogger).log(event);

export const setEnterpriseStructuredLoggerForTest = (
  logger: EnterpriseStructuredLogger | null,
): void => {
  injectedLogger = logger;
};
