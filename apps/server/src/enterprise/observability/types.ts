import type {
  EnterpriseAgentMaterializationOutcome,
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
  EnterpriseOidcFailureCategory,
  EnterpriseOidcLoginStage,
  EnterpriseOperationalCollectionOutcome,
  EnterpriseOperationalCollector,
  EnterpriseSsrfDenialCategory,
} from '@lobechat/observability-otel/modules/enterprise-platform';

/** Closed publication vocabulary (`publish` | `rollback` | `save`) re-exported for services. */
export type { EnterpriseConfigPublishOperation };

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

export interface EnterpriseSsrfDenialEvent {
  category: EnterpriseSsrfDenialCategory;
  outcome?: never;
  type: 'ssrf_denial';
}

export type EnterpriseOidcLoginEvent =
  | {
      outcome: 'success';
      stage: EnterpriseOidcLoginStage;
      type: 'oidc_login';
    }
  | {
      failureCategory: EnterpriseOidcFailureCategory;
      outcome: 'failure';
      stage: EnterpriseOidcLoginStage;
      type: 'oidc_login';
    };

export interface EnterpriseAgentMaterializationEvent {
  durationMs: number;
  outcome: EnterpriseAgentMaterializationOutcome;
  type: 'agent_materialization';
}

export interface EnterpriseOperationalCollectionEvent {
  collector: EnterpriseOperationalCollector;
  durationMs: number;
  errorClass?: EnterpriseObservabilityErrorClass;
  outcome: EnterpriseOperationalCollectionOutcome;
  type: 'operational_collection';
}

export type EnterpriseObservabilityEvent =
  | EnterpriseAgentMaterializationEvent
  | EnterpriseCacheEvent
  | EnterpriseConfigPublishEvent
  | EnterpriseGuardDecisionEvent
  | EnterpriseInstanceHeartbeatEvent
  | EnterpriseInvalidationEvent
  | EnterpriseOidcLoginEvent
  | EnterpriseOperationalCollectionEvent
  | EnterpriseSsrfDenialEvent;

const ERROR_CODE_CLASSES = {
  ABORT_ERR: 'TimeoutError',
  ECONNREFUSED: 'UnavailableError',
  ECONNRESET: 'UnavailableError',
  ETIMEDOUT: 'TimeoutError',
  PLATFORM_CONFIG_VALIDATION_FAILED: 'ValidationError',
  PLATFORM_REVISION_CONFLICT: 'ConflictError',
} as const satisfies Readonly<Record<string, EnterpriseObservabilityErrorClass>>;

const stableErrorCode = (error: unknown): keyof typeof ERROR_CODE_CLASSES | undefined => {
  if (!(error instanceof Error) || !Object.hasOwn(error, 'code')) return undefined;
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return typeof code === 'string' && Object.hasOwn(ERROR_CODE_CLASSES, code)
    ? (code as keyof typeof ERROR_CODE_CLASSES)
    : undefined;
};

export const classifyEnterpriseError = (error: unknown): EnterpriseObservabilityErrorClass => {
  const errorCode = stableErrorCode(error);
  if (errorCode) return ERROR_CODE_CLASSES[errorCode];
  const name = error instanceof Error ? error.name.toLowerCase() : '';
  if (name.includes('conflict')) return 'ConflictError';
  if (name.includes('abort') || name.includes('timeout')) return 'TimeoutError';
  if (name.includes('unavailable') || name.includes('connection')) return 'UnavailableError';
  if (name.includes('validation') || name.includes('zod')) return 'ValidationError';
  return 'UnexpectedError';
};
