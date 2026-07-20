import type {
  EnterpriseCacheDomain,
  EnterpriseCacheEpochOutcome,
  EnterpriseCacheLoadOutcome,
  EnterpriseCacheRequestOutcome,
  EnterpriseConfigDomain,
  EnterpriseConfigPublishOperation,
  EnterpriseConfigPublishOutcome,
  EnterpriseGuardClassification,
  EnterpriseGuardMode,
  EnterpriseGuardOutcome,
  EnterpriseGuardResource,
  EnterpriseHeartbeatOperation,
  EnterpriseHeartbeatOutcome,
  EnterpriseInvalidationBackend,
  EnterpriseInvalidationOutcome,
} from '@lobechat/observability-otel/modules/enterprise-platform';

export type EnterpriseObservabilityErrorClass =
  'ConflictError' | 'TimeoutError' | 'UnavailableError' | 'UnexpectedError' | 'ValidationError';

export interface EnterpriseConfigPublishEvent {
  domain: EnterpriseConfigDomain;
  durationMs: number;
  errorClass?: EnterpriseObservabilityErrorClass;
  operation: EnterpriseConfigPublishOperation;
  outcome: EnterpriseConfigPublishOutcome;
  type: 'config_publish';
}

export interface EnterpriseInvalidationEvent {
  backend: EnterpriseInvalidationBackend;
  errorClass?: EnterpriseObservabilityErrorClass;
  outcome: EnterpriseInvalidationOutcome;
  type: 'invalidation';
}

export type EnterpriseCacheEvent =
  | {
      domain: EnterpriseCacheDomain;
      operation: 'epoch';
      outcome: EnterpriseCacheEpochOutcome;
      type: 'cache';
    }
  | {
      domain: EnterpriseCacheDomain;
      errorClass?: EnterpriseObservabilityErrorClass;
      operation: 'load';
      outcome: EnterpriseCacheLoadOutcome;
      type: 'cache';
    }
  | {
      domain: EnterpriseCacheDomain;
      operation: 'request';
      outcome: EnterpriseCacheRequestOutcome;
      type: 'cache';
    };

export interface EnterpriseGuardDecisionEvent {
  classification: EnterpriseGuardClassification;
  mode: EnterpriseGuardMode;
  outcome: EnterpriseGuardOutcome;
  resource: EnterpriseGuardResource;
  type: 'guard_decision';
}

export interface EnterpriseInstanceHeartbeatEvent {
  durationMs: number;
  errorClass?: EnterpriseObservabilityErrorClass;
  operation: EnterpriseHeartbeatOperation;
  outcome: EnterpriseHeartbeatOutcome;
  type: 'instance_heartbeat';
}

export type EnterpriseObservabilityEvent =
  | EnterpriseCacheEvent
  | EnterpriseConfigPublishEvent
  | EnterpriseGuardDecisionEvent
  | EnterpriseInstanceHeartbeatEvent
  | EnterpriseInvalidationEvent;

export const classifyEnterpriseError = (error: unknown): EnterpriseObservabilityErrorClass => {
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  if (name.includes('conflict')) return 'ConflictError';
  if (name.includes('abort') || name.includes('timeout')) return 'TimeoutError';
  if (name.includes('unavailable') || name.includes('connection')) return 'UnavailableError';
  if (name.includes('validation') || name.includes('zod')) return 'ValidationError';
  return 'UnexpectedError';
};
