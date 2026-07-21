/**
 * Allowlisted operator commands with real postcondition verification.
 * No recursive self-dispatch dry-run can report executed success.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  applyCommandTransition,
  digestCommandState,
  HIGH_RISK_FLAG_BY_COMMAND,
  loadCommandState,
} from './commandState';
import { ALLOWLISTED_COMMAND_IDS, type AllowlistedCommandId } from './constants';
import { buildDefaultReleasePlan as buildPlanInternal } from './releasePlan';

export interface AllowlistedCommandDefinition {
  description: string;
  id: AllowlistedCommandId;
  /**
   * Kind of real operation. `unavailable` always fails when execute is requested
   * unless a local harness state backend is configured.
   */
  kind:
    | 'drill-cli'
    | 'flag-toggle'
    | 'monitor-metrics'
    | 'preflight-cli'
    | 'unavailable'
    | 'window-control';
  mutates: boolean;
}

export const ALLOWLISTED_COMMANDS: Readonly<
  Record<AllowlistedCommandId, AllowlistedCommandDefinition>
> = {
  'preflight-validate': {
    id: 'preflight-validate',
    description: 'Validate preflight harness contracts',
    mutates: false,
    kind: 'preflight-cli',
  },
  'preflight-evaluate': {
    id: 'preflight-evaluate',
    description: 'Evaluate release candidate evidence',
    mutates: false,
    kind: 'preflight-cli',
  },
  'backup-restore-drill-local': {
    id: 'backup-restore-drill-local',
    description: 'Local harness backup/restore drill',
    mutates: true,
    kind: 'drill-cli',
  },
  'backup-restore-drill-production-authorized': {
    id: 'backup-restore-drill-production-authorized',
    description: 'Production backup/restore requires signed backup provenance',
    mutates: true,
    kind: 'unavailable',
  },
  'app-rollback-drill-local': {
    id: 'app-rollback-drill-local',
    description: 'Local app-rollback drill',
    mutates: true,
    kind: 'drill-cli',
  },
  'app-rollback-drill-production-authorized': {
    id: 'app-rollback-drill-production-authorized',
    description: 'Production app-rollback requires signed provenance',
    mutates: true,
    kind: 'unavailable',
  },
  'release-window-activate': {
    id: 'release-window-activate',
    description: 'Activate next release window in harness state',
    mutates: true,
    kind: 'window-control',
  },
  'release-window-rollback': {
    id: 'release-window-rollback',
    description: 'Rollback active release window in harness state',
    mutates: true,
    kind: 'window-control',
  },
  'release-window-verify-rollback': {
    id: 'release-window-verify-rollback',
    description: 'Verify window rolled back (windowActive null)',
    mutates: false,
    kind: 'window-control',
  },
  'flag-enable-oidc': {
    id: 'flag-enable-oidc',
    description: 'Enable OIDC flag in harness state',
    mutates: true,
    kind: 'flag-toggle',
  },
  'flag-disable-oidc': {
    id: 'flag-disable-oidc',
    description: 'Disable OIDC flag in harness state',
    mutates: true,
    kind: 'flag-toggle',
  },
  'flag-enable-connector-shared-credentials': {
    id: 'flag-enable-connector-shared-credentials',
    description: 'Enable connector shared credentials flag',
    mutates: true,
    kind: 'flag-toggle',
  },
  'flag-disable-connector-shared-credentials': {
    id: 'flag-disable-connector-shared-credentials',
    description: 'Disable connector shared credentials flag',
    mutates: true,
    kind: 'flag-toggle',
  },
  'flag-enable-default-inbox': {
    id: 'flag-enable-default-inbox',
    description: 'Enable default inbox flag',
    mutates: true,
    kind: 'flag-toggle',
  },
  'flag-disable-default-inbox': {
    id: 'flag-disable-default-inbox',
    description: 'Disable default inbox flag',
    mutates: true,
    kind: 'flag-toggle',
  },
  'flag-enable-branding-cutover': {
    id: 'flag-enable-branding-cutover',
    description: 'Enable branding cutover flag',
    mutates: true,
    kind: 'flag-toggle',
  },
  'flag-disable-branding-cutover': {
    id: 'flag-disable-branding-cutover',
    description: 'Disable branding cutover flag',
    mutates: true,
    kind: 'flag-toggle',
  },
  'monitor-release-window': {
    id: 'monitor-release-window',
    description: 'Read metrics from harness state and enforce thresholds',
    mutates: false,
    kind: 'monitor-metrics',
  },
  'disaster-recovery-select-backup': {
    id: 'disaster-recovery-select-backup',
    description: 'Select production backup (requires external authorization)',
    mutates: false,
    kind: 'unavailable',
  },
  'disaster-recovery-isolated-restore': {
    id: 'disaster-recovery-isolated-restore',
    description: 'Isolated restore (requires signed backup)',
    mutates: true,
    kind: 'unavailable',
  },
  'disaster-recovery-verify-invariants': {
    id: 'disaster-recovery-verify-invariants',
    description: 'Verify DR invariants (requires restore evidence)',
    mutates: false,
    kind: 'unavailable',
  },
};

export const isAllowlistedCommandId = (value: string): value is AllowlistedCommandId =>
  (ALLOWLISTED_COMMAND_IDS as readonly string[]).includes(value);

export interface DispatchOptions {
  commandId: string;
  confirmExecute: boolean;
  cwd?: string;
  execute: boolean;
  /** Stable operation id for replay ledger (optional). */
  operationId?: string;
  /** Directory for harness command state (required for flag/window/monitor execute). */
  stateDir?: string;
  /** Optional metric thresholds for monitor. */
  stopThresholds?: Record<string, number>;
  windowId?: string;
}

export type DispatchMode =
  | 'already-satisfied'
  | 'dry-run'
  | 'executed'
  | 'no-change'
  | 'observed'
  | 'replayed'
  | 'unavailable'
  | 'verified';

export interface DispatchResult {
  afterDigest?: string;
  beforeDigest?: string;
  commandId: AllowlistedCommandId;
  exitCode: number | null;
  mode: DispatchMode;
  mutates: boolean;
  postcondition?: string;
}

const sanitizeId = (value: string): string => value.replaceAll(/[^a-z0-9-]/giu, '_').slice(0, 64);

export const dispatchAllowlistedCommand = async (
  options: DispatchOptions,
): Promise<DispatchResult> => {
  const commandId = options.commandId;
  if (!isAllowlistedCommandId(commandId)) {
    throw new Error(`Command id is not allowlisted: ${sanitizeId(commandId)}`);
  }
  if (/[;&|`$(){}<>\s]|\\n|\\r/u.test(commandId)) {
    throw new Error('Command id injection rejected');
  }

  const definition = ALLOWLISTED_COMMANDS[commandId];

  if (!options.execute) {
    return {
      commandId,
      exitCode: null,
      mode: 'dry-run',
      mutates: definition.mutates,
    };
  }

  if (definition.mutates && !options.confirmExecute) {
    throw new Error('Mutating command requires explicit confirmExecute');
  }

  if (definition.kind === 'unavailable') {
    return {
      commandId,
      exitCode: 1,
      mode: 'unavailable',
      mutates: definition.mutates,
      postcondition: 'no-safe-production-implementation',
    };
  }

  if (definition.kind === 'preflight-cli' || definition.kind === 'drill-cli') {
    // These require explicit operator argv outside dispatch for real runs;
    // execute without state is unavailable to avoid recursive no-op success.
    return {
      commandId,
      exitCode: 1,
      mode: 'unavailable',
      mutates: definition.mutates,
      postcondition: 'use-package-script-entrypoint-directly',
    };
  }

  const stateDir =
    options.stateDir ?? path.join(process.cwd(), '.records/enterprise-production-readiness');

  if (definition.kind === 'flag-toggle') {
    const flag = HIGH_RISK_FLAG_BY_COMMAND[commandId];
    if (!flag) {
      return { commandId, exitCode: 1, mode: 'unavailable', mutates: true };
    }
    const enable = commandId.startsWith('flag-enable-');
    try {
      const result = await applyCommandTransition({
        baseDir: stateDir,
        operationId: options.operationId,
        mutate: (state) => {
          if (state.flags[flag] === enable) {
            return {
              changed: false,
              next: state,
              postcondition: `flag:${flag}=${enable}:no-change`,
            };
          }
          state.flags[flag] = enable;
          return {
            changed: true,
            next: state,
            postcondition: `flag:${flag}=${enable}`,
          };
        },
      });
      return {
        afterDigest: result.afterDigest,
        beforeDigest: result.beforeDigest,
        commandId,
        exitCode: result.mode === 'conflict' ? 1 : 0,
        mode: result.mode === 'conflict' ? 'unavailable' : result.mode,
        mutates: true,
        postcondition: result.postcondition,
      };
    } catch (error) {
      return {
        commandId,
        exitCode: 1,
        mode: 'unavailable',
        mutates: true,
        postcondition: error instanceof Error ? error.message : 'flag-transition-failed',
      };
    }
  }

  if (definition.kind === 'window-control') {
    if (commandId === 'release-window-activate') {
      const windowId = options.windowId ?? 'milestone-a';
      try {
        const result = await applyCommandTransition({
          baseDir: stateDir,
          operationId: options.operationId,
          mutate: (state) => {
            if (state.windowActive === windowId) {
              return {
                changed: false,
                next: state,
                postcondition: `windowActive=${windowId}:no-change`,
              };
            }
            state.windowActive = windowId;
            return {
              changed: true,
              next: state,
              postcondition: `windowActive=${windowId}`,
            };
          },
        });
        return {
          afterDigest: result.afterDigest,
          beforeDigest: result.beforeDigest,
          commandId,
          exitCode: result.mode === 'conflict' ? 1 : 0,
          mode: result.mode === 'conflict' ? 'unavailable' : result.mode,
          mutates: true,
          postcondition: result.postcondition,
        };
      } catch (error) {
        return {
          commandId,
          exitCode: 1,
          mode: 'unavailable',
          mutates: true,
          postcondition: error instanceof Error ? error.message : 'window-transition-failed',
        };
      }
    }
    if (commandId === 'release-window-rollback') {
      try {
        const result = await applyCommandTransition({
          baseDir: stateDir,
          operationId: options.operationId,
          mutate: (state) => {
            if (
              state.windowActive === null &&
              Object.values(state.flags).every((value) => value === false)
            ) {
              return {
                changed: false,
                next: state,
                postcondition: 'windowActive=null:no-change',
              };
            }
            state.windowActive = null;
            for (const key of Object.keys(state.flags)) state.flags[key] = false;
            return { changed: true, next: state, postcondition: 'windowActive=null' };
          },
        });
        return {
          afterDigest: result.afterDigest,
          beforeDigest: result.beforeDigest,
          commandId,
          exitCode: result.mode === 'conflict' ? 1 : 0,
          mode: result.mode === 'conflict' ? 'unavailable' : result.mode,
          mutates: true,
          postcondition: result.postcondition,
        };
      } catch (error) {
        return {
          commandId,
          exitCode: 1,
          mode: 'unavailable',
          mutates: true,
          postcondition: error instanceof Error ? error.message : 'window-rollback-failed',
        };
      }
    }
    const reloaded = await loadCommandState(stateDir);
    const ok = reloaded.windowActive === null;
    return {
      afterDigest: digestCommandState(reloaded),
      beforeDigest: digestCommandState(reloaded),
      commandId,
      exitCode: ok ? 0 : 1,
      mode: 'verified',
      mutates: false,
      postcondition: ok ? 'rollback-verified' : 'rollback-not-verified',
    };
  }

  if (definition.kind === 'monitor-metrics') {
    const reloaded = await loadCommandState(stateDir);
    const thresholds = options.stopThresholds ?? {
      'error-rate': 0.01,
      'auth-failure-rate': 0.02,
    };
    for (const [metric, threshold] of Object.entries(thresholds)) {
      const value = reloaded.metrics[metric] ?? 0;
      if (value > threshold) {
        return {
          afterDigest: digestCommandState(reloaded),
          beforeDigest: digestCommandState(reloaded),
          commandId,
          exitCode: 1,
          mode: 'observed',
          mutates: false,
          postcondition: `threshold-breached:${metric}`,
        };
      }
    }
    return {
      afterDigest: digestCommandState(reloaded),
      beforeDigest: digestCommandState(reloaded),
      commandId,
      exitCode: 0,
      mode: 'observed',
      mutates: false,
      postcondition: 'metrics-within-thresholds',
    };
  }

  return {
    commandId,
    exitCode: 1,
    mode: 'unavailable',
    mutates: definition.mutates,
  };
};

/** @deprecated No fixed argv recursion — kept for tests that assert injection rejection of ids. */
export const resolveAllowlistedArgv = (commandId: string): readonly string[] => {
  if (!isAllowlistedCommandId(commandId)) {
    throw new Error(`Command id is not allowlisted: ${sanitizeId(commandId)}`);
  }
  if (/[;&|`$(){}]/u.test(commandId)) {
    throw new Error('Command id contains forbidden shell metacharacters');
  }
  // Fixed package-script templates only for drill/preflight kinds; others return empty.
  const definition = ALLOWLISTED_COMMANDS[commandId];
  if (definition.kind === 'preflight-cli' && commandId === 'preflight-validate') {
    return ['bun', 'run', 'enterprise:preflight', 'validate-harness'] as const;
  }
  if (definition.kind === 'drill-cli' && commandId === 'backup-restore-drill-local') {
    return [
      'bun',
      'run',
      'enterprise:recovery-drill',
      'backup-restore',
      '--scope',
      'local-harness',
    ] as const;
  }
  throw new Error(`No fixed argv template for command ${commandId}`);
};

export const buildDefaultReleasePlan = buildPlanInternal;

/** Bound process runner used only when executing real package scripts from tests. */
export const runArgv = (
  argv: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<number> =>
  new Promise((resolve, reject) => {
    const [file, ...args] = argv;
    if (!file) {
      reject(new Error('Empty argv'));
      return;
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Command timed out'));
    }, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
