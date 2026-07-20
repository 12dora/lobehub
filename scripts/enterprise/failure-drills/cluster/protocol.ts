export const CLUSTER_RUNTIME_COMMANDS = ['load', 'shutdown', 'status'] as const;

export type ClusterRuntimeCommand = (typeof CLUSTER_RUNTIME_COMMANDS)[number];

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
        diverged: number;
        fresh: number;
        matching: number;
        status: string;
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
      errorCategory?: 'command_failed';
      id: number;
      ok: boolean;
      type: 'result';
      value?: ClusterRuntimeValue;
    };

export const isClusterRuntimeMessage = (value: unknown): value is ClusterRuntimeMessage => {
  if (!value || typeof value !== 'object') return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'ready') return Object.keys(message).length === 1;
  if (
    message.type !== 'result' ||
    !Number.isSafeInteger(message.id) ||
    typeof message.ok !== 'boolean'
  ) {
    return false;
  }
  return message.ok
    ? Boolean(message.value && typeof message.value === 'object')
    : message.errorCategory === 'command_failed';
};
