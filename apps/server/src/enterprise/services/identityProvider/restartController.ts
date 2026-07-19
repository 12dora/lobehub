export type RestartUnsupportedReason =
  'edge_runtime' | 'serverless_runtime' | 'supervisor_not_configured' | 'test_runtime';

export interface RestartCapability {
  reason: RestartUnsupportedReason | null;
  supported: boolean;
}

export interface RestartSignalInput {
  ownerFence: string;
  requestId: string;
}

export interface RestartController {
  capability: () => RestartCapability;
  schedule: (input: RestartSignalInput) => Promise<void>;
}

export const resolveRestartCapability = (
  env: Record<string, string | undefined> = process.env,
): RestartCapability => {
  if (env.NODE_ENV === 'test' || env.VITEST) return { reason: 'test_runtime', supported: false };
  if (env.NEXT_RUNTIME === 'edge') return { reason: 'edge_runtime', supported: false };
  if (
    env.VERCEL ||
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.AWS_EXECUTION_ENV?.startsWith('AWS_Lambda_')
  ) {
    return { reason: 'serverless_runtime', supported: false };
  }
  if (env.PLATFORM_OIDC_RESTART_MODE !== 'supervisor') {
    return { reason: 'supervisor_not_configured', supported: false };
  }
  return { reason: null, supported: true };
};

export interface ProcessRestartControllerOptions {
  delayMs?: number;
  env?: Record<string, string | undefined>;
  signal?: () => void;
}

/**
 * Schedules SIGTERM for this process only. The delay lets the committed tRPC response flush; the
 * configured supervisor owns the subsequent start. No PID or command is accepted from callers.
 */
export class ProcessRestartController implements RestartController {
  private readonly delayMs: number;
  private readonly env: Record<string, string | undefined>;
  private readonly signal: () => void;

  constructor(options: ProcessRestartControllerOptions = {}) {
    this.delayMs = options.delayMs ?? 1500;
    this.env = options.env ?? process.env;
    this.signal = options.signal ?? (() => process.kill(process.pid, 'SIGTERM'));
  }

  capability = (): RestartCapability => resolveRestartCapability(this.env);

  schedule = async (input: RestartSignalInput): Promise<void> => {
    const capability = this.capability();
    if (!capability.supported) throw new Error('PLATFORM_OIDC_RESTART_UNSUPPORTED');
    console.info('[identityProviderRestart] graceful restart scheduled', {
      delayMs: this.delayMs,
      requestId: input.requestId,
    });
    const timer = setTimeout(() => {
      console.info('[identityProviderRestart] sending graceful SIGTERM', {
        requestId: input.requestId,
      });
      this.signal();
    }, this.delayMs);
    timer.unref?.();
  };
}
