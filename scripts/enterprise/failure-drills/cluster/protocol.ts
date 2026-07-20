import { isPlainRecord } from '@lobechat/utils/object';

export const CLUSTER_RUNTIME_COMMANDS = ['load', 'shutdown', 'status'] as const;
export const CLUSTER_RUNTIME_ERROR_CATEGORIES = ['command_failed', 'protocol_error'] as const;
export const CLUSTER_RUNTIME_MAX_REQUEST_LINE_BYTES = 8 * 1024;
export const CLUSTER_RUNTIME_STATUSES = [
  'converged',
  'degraded',
  'disabled',
  'diverged',
  'not_applicable',
  'unavailable',
  'unreported',
] as const;

export type ClusterRuntimeCommand = (typeof CLUSTER_RUNTIME_COMMANDS)[number];
export type ClusterRuntimeErrorCategory = (typeof CLUSTER_RUNTIME_ERROR_CATEGORIES)[number];
export type ClusterRuntimeStatus = (typeof CLUSTER_RUNTIME_STATUSES)[number];

export interface ClusterRuntimeRequest {
  id: number;
  type: ClusterRuntimeCommand;
}

export type ClusterRuntimeValue =
  | {
      kind: 'load';
      revision: number;
    }
  | {
      branding: {
        degraded: number;
        domain: 'branding';
        diverged: number;
        fresh: number;
        matching: number;
        status: ClusterRuntimeStatus;
        unreported: number;
      };
      kind: 'status';
    }
  | {
      kind: 'shutdown';
    };

export type ClusterRuntimeMessage =
  | { type: 'ready' }
  | {
      id: number;
      ok: true;
      type: 'result';
      value: ClusterRuntimeValue;
    }
  | {
      errorCategory: ClusterRuntimeErrorCategory;
      id: number;
      ok: false;
      type: 'result';
    };

export type ClusterRuntimeRequestFrame =
  | { kind: 'reject'; id: number }
  | { kind: 'request'; request: ClusterRuntimeRequest }
  | { kind: 'terminate' };

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const isPositiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const isNonnegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const isCommand = (value: unknown): value is ClusterRuntimeCommand =>
  typeof value === 'string' && CLUSTER_RUNTIME_COMMANDS.includes(value as ClusterRuntimeCommand);

const isErrorCategory = (value: unknown): value is ClusterRuntimeErrorCategory =>
  typeof value === 'string' &&
  CLUSTER_RUNTIME_ERROR_CATEGORIES.includes(value as ClusterRuntimeErrorCategory);

const isStatus = (value: unknown): value is ClusterRuntimeStatus =>
  typeof value === 'string' && CLUSTER_RUNTIME_STATUSES.includes(value as ClusterRuntimeStatus);

const isBrandingStatus = (
  value: unknown,
): value is Extract<ClusterRuntimeValue, { kind: 'status' }>['branding'] => {
  if (!isPlainRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'degraded',
      'diverged',
      'domain',
      'fresh',
      'matching',
      'status',
      'unreported',
    ])
  ) {
    return false;
  }
  return (
    isNonnegativeSafeInteger(value.degraded) &&
    value.domain === 'branding' &&
    isNonnegativeSafeInteger(value.diverged) &&
    isNonnegativeSafeInteger(value.fresh) &&
    isNonnegativeSafeInteger(value.matching) &&
    isStatus(value.status) &&
    isNonnegativeSafeInteger(value.unreported)
  );
};

const isClusterRuntimeValue = (value: unknown): value is ClusterRuntimeValue => {
  if (!isPlainRecord(value)) return false;
  switch (value.kind) {
    case 'load': {
      return hasExactKeys(value, ['kind', 'revision']) && isPositiveSafeInteger(value.revision);
    }
    case 'shutdown': {
      return hasExactKeys(value, ['kind']);
    }
    case 'status': {
      return hasExactKeys(value, ['branding', 'kind']) && isBrandingStatus(value.branding);
    }
    default: {
      return false;
    }
  }
};

export const isClusterRuntimeRequest = (value: unknown): value is ClusterRuntimeRequest =>
  isPlainRecord(value) &&
  hasExactKeys(value, ['id', 'type']) &&
  isPositiveSafeInteger(value.id) &&
  isCommand(value.type);

export const getClusterRuntimeFrameId = (value: unknown): number | null =>
  isPlainRecord(value) && isPositiveSafeInteger(value.id) ? value.id : null;

export const decodeClusterRuntimeRequestFrame = (line: string): ClusterRuntimeRequestFrame => {
  if (Buffer.byteLength(line) > CLUSTER_RUNTIME_MAX_REQUEST_LINE_BYTES) {
    return { kind: 'terminate' };
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'terminate' };
  }
  if (isClusterRuntimeRequest(value)) return { kind: 'request', request: value };
  const id = getClusterRuntimeFrameId(value);
  return id === null ? { kind: 'terminate' } : { id, kind: 'reject' };
};

export const isClusterRuntimeMessage = (value: unknown): value is ClusterRuntimeMessage => {
  if (!isPlainRecord(value)) return false;
  if (value.type === 'ready') return hasExactKeys(value, ['type']);
  if (value.type !== 'result' || !isPositiveSafeInteger(value.id)) return false;
  if (value.ok === true) {
    return hasExactKeys(value, ['id', 'ok', 'type', 'value']) && isClusterRuntimeValue(value.value);
  }
  return (
    value.ok === false &&
    hasExactKeys(value, ['errorCategory', 'id', 'ok', 'type']) &&
    isErrorCategory(value.errorCategory)
  );
};
