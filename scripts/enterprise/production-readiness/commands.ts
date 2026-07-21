/**
 * Allowlisted operator commands. Dispatch only via argv arrays — never shell strings.
 */
import { spawn } from 'node:child_process';

import { ALLOWLISTED_COMMAND_IDS, type AllowlistedCommandId } from './constants';

export interface AllowlistedCommandDefinition {
  /** Fixed argv template; placeholders are substituted from a typed map only. */
  argv: readonly string[];
  description: string;
  id: AllowlistedCommandId;
  /** Whether this command mutates runtime state (requires execute confirmation). */
  mutates: boolean;
}

/**
 * Built-in allowlist. Command JSON may only reference these ids.
 * argv never includes shell metacharacters or interpolated secrets.
 */
export const ALLOWLISTED_COMMANDS: Readonly<
  Record<AllowlistedCommandId, AllowlistedCommandDefinition>
> = {
  'preflight-validate': {
    id: 'preflight-validate',
    argv: ['bun', 'run', 'enterprise:preflight', 'validate-harness'],
    mutates: false,
    description: 'Validate preflight harness contracts without production pass claim',
  },
  'preflight-evaluate': {
    id: 'preflight-evaluate',
    argv: ['bun', 'run', 'enterprise:preflight', 'preflight'],
    mutates: false,
    description: 'Evaluate release candidate evidence (read-only by default)',
  },
  'backup-restore-drill-local': {
    id: 'backup-restore-drill-local',
    argv: ['bun', 'run', 'enterprise:recovery-drill', 'backup-restore', '--scope', 'local-harness'],
    mutates: true,
    description: 'Owned ephemeral PostgreSQL backup/restore drill (local-harness only)',
  },
  'backup-restore-drill-production-authorized': {
    id: 'backup-restore-drill-production-authorized',
    argv: [
      'bun',
      'run',
      'enterprise:recovery-drill',
      'backup-restore',
      '--scope',
      'production-authorized',
    ],
    mutates: true,
    description: 'Production-authorized backup/restore drill against isolated restore target',
  },
  'app-rollback-drill-local': {
    id: 'app-rollback-drill-local',
    argv: ['bun', 'run', 'enterprise:recovery-drill', 'app-rollback', '--scope', 'local-harness'],
    mutates: true,
    description: 'Local harness app-version rollback compatibility drill',
  },
  'app-rollback-drill-production-authorized': {
    id: 'app-rollback-drill-production-authorized',
    argv: [
      'bun',
      'run',
      'enterprise:recovery-drill',
      'app-rollback',
      '--scope',
      'production-authorized',
    ],
    mutates: true,
    description: 'Production-authorized app-version rollback compatibility drill',
  },
  'release-window-activate': {
    id: 'release-window-activate',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'release-window-activate',
    ],
    mutates: true,
    description: 'Activate the next approved release window (allowlisted flag flip)',
  },
  'release-window-rollback': {
    id: 'release-window-rollback',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'release-window-rollback',
    ],
    mutates: true,
    description: 'Rollback the active release window to the previous stable flags',
  },
  'release-window-verify-rollback': {
    id: 'release-window-verify-rollback',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'release-window-verify-rollback',
    ],
    mutates: false,
    description: 'Verify rollback state after a release-window rollback',
  },
  'flag-enable-oidc': {
    id: 'flag-enable-oidc',
    argv: ['bun', 'run', 'enterprise:preflight', 'dispatch', '--command-id', 'flag-enable-oidc'],
    mutates: true,
    description: 'Enable OIDC first-enable capability for its dedicated window',
  },
  'flag-disable-oidc': {
    id: 'flag-disable-oidc',
    argv: ['bun', 'run', 'enterprise:preflight', 'dispatch', '--command-id', 'flag-disable-oidc'],
    mutates: true,
    description: 'Disable OIDC capability (rollback)',
  },
  'flag-enable-connector-shared-credentials': {
    id: 'flag-enable-connector-shared-credentials',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'flag-enable-connector-shared-credentials',
    ],
    mutates: true,
    description: 'Enable shared connector credentials for its dedicated window',
  },
  'flag-disable-connector-shared-credentials': {
    id: 'flag-disable-connector-shared-credentials',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'flag-disable-connector-shared-credentials',
    ],
    mutates: true,
    description: 'Disable shared connector credentials (rollback)',
  },
  'flag-enable-default-inbox': {
    id: 'flag-enable-default-inbox',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'flag-enable-default-inbox',
    ],
    mutates: true,
    description: 'Enable default Inbox takeover for its dedicated window',
  },
  'flag-disable-default-inbox': {
    id: 'flag-disable-default-inbox',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'flag-disable-default-inbox',
    ],
    mutates: true,
    description: 'Disable default Inbox takeover (rollback)',
  },
  'flag-enable-branding-cutover': {
    id: 'flag-enable-branding-cutover',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'flag-enable-branding-cutover',
    ],
    mutates: true,
    description: 'Enable branding name cutover for its dedicated window',
  },
  'flag-disable-branding-cutover': {
    id: 'flag-disable-branding-cutover',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'flag-disable-branding-cutover',
    ],
    mutates: true,
    description: 'Disable branding cutover (rollback)',
  },
  'monitor-release-window': {
    id: 'monitor-release-window',
    argv: [
      'bun',
      'run',
      'enterprise:preflight',
      'dispatch',
      '--command-id',
      'monitor-release-window',
    ],
    mutates: false,
    description: 'Observe release-window metrics for the configured monitor duration',
  },
  'disaster-recovery-select-backup': {
    id: 'disaster-recovery-select-backup',
    argv: [
      'bun',
      'run',
      'enterprise:recovery-drill',
      'select-backup',
      '--scope',
      'production-authorized',
    ],
    mutates: false,
    description: 'Select and digest a production backup artifact for DR',
  },
  'disaster-recovery-isolated-restore': {
    id: 'disaster-recovery-isolated-restore',
    argv: [
      'bun',
      'run',
      'enterprise:recovery-drill',
      'backup-restore',
      '--scope',
      'production-authorized',
    ],
    mutates: true,
    description: 'Restore selected backup into an isolated target only',
  },
  'disaster-recovery-verify-invariants': {
    id: 'disaster-recovery-verify-invariants',
    argv: [
      'bun',
      'run',
      'enterprise:recovery-drill',
      'verify-invariants',
      '--scope',
      'production-authorized',
    ],
    mutates: false,
    description: 'Verify revision/audit/secret-ref invariants after isolated restore',
  },
};

export const isAllowlistedCommandId = (value: string): value is AllowlistedCommandId =>
  (ALLOWLISTED_COMMAND_IDS as readonly string[]).includes(value);

/**
 * Reject shell injection attempts and unknown command ids.
 * Returns the fixed argv array from the allowlist only.
 */
export const resolveAllowlistedArgv = (commandId: string): readonly string[] => {
  if (!isAllowlistedCommandId(commandId)) {
    throw new Error(`Command id is not allowlisted: ${sanitizeId(commandId)}`);
  }
  if (/[;&|`$(){}]|\\n|\\r/u.test(commandId)) {
    throw new Error('Command id contains forbidden shell metacharacters');
  }
  return ALLOWLISTED_COMMANDS[commandId].argv;
};

const sanitizeId = (value: string): string => value.replaceAll(/[^a-z0-9-]/giu, '_').slice(0, 64);

export interface DispatchOptions {
  commandId: string;
  /** Must be true to run mutates=true commands. */
  confirmExecute: boolean;
  cwd?: string;
  /** Explicit execute mode; default is dry-run / resolve-only. */
  execute: boolean;
  /** Optional timeout for bounded process execution. */
  timeoutMs?: number;
}

export interface DispatchResult {
  argv: readonly string[];
  commandId: AllowlistedCommandId;
  exitCode: number | null;
  mode: 'dry-run' | 'executed';
  mutates: boolean;
}

/**
 * Resolve or dispatch an allowlisted command.
 * Never evaluates shell strings. Dry-run by default.
 */
export const dispatchAllowlistedCommand = async (
  options: DispatchOptions,
): Promise<DispatchResult> => {
  const commandId = options.commandId;
  if (!isAllowlistedCommandId(commandId)) {
    throw new Error(`Command id is not allowlisted: ${sanitizeId(commandId)}`);
  }
  // Reject injection payloads even if somehow cast.
  if (/[;&|`$(){}<>\s]|\\n|\\r/u.test(commandId)) {
    throw new Error('Command id injection rejected');
  }

  const definition = ALLOWLISTED_COMMANDS[commandId];
  const argv = definition.argv;

  // Defense-in-depth: argv entries must not look like shell metacharacter glue.
  for (const part of argv) {
    if (/[;&|`$]/u.test(part) || part.includes('\n') || part.includes('\r')) {
      throw new Error('Allowlisted argv entry failed injection scan');
    }
  }

  if (!options.execute) {
    return {
      argv,
      commandId,
      exitCode: null,
      mode: 'dry-run',
      mutates: definition.mutates,
    };
  }

  if (definition.mutates && !options.confirmExecute) {
    throw new Error('Mutating command requires explicit confirmExecute');
  }

  const exitCode = await runArgv(argv, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs ?? 120_000,
  });

  return {
    argv,
    commandId,
    exitCode,
    mode: 'executed',
    mutates: definition.mutates,
  };
};

const runArgv = (
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
      reject(new Error('Allowlisted command timed out'));
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

/** Build a default Milestone A–F release plan for a candidate (operator baseline). */
export const buildDefaultReleasePlan = (input: { candidateGitSha: string; releaseId: string }) => {
  const sharedMetrics = [
    'error-rate',
    'p95-latency-ms',
    'auth-failure-rate',
    'job-failure-rate',
  ] as const;

  const stop = (id: string, metricId: (typeof sharedMetrics)[number], threshold: number) => ({
    comparator: 'gt' as const,
    id,
    metricId,
    threshold,
  });

  return {
    candidateGitSha: input.candidateGitSha,
    releaseId: input.releaseId,
    schemaVersion: 1 as const,
    windows: [
      {
        approval: 'required' as const,
        firstEnableCapability: 'none' as const,
        forwardCommandIds: ['release-window-activate' as const, 'monitor-release-window' as const],
        id: 'milestone-a' as const,
        metricIds: [...sharedMetrics],
        monitorDurationMinutes: 60,
        order: 1,
        ownerRole: 'platform-sre',
        prerequisites: ['preflight-passed'],
        rollbackCommandIds: ['release-window-rollback' as const],
        rollbackVerificationCommandIds: ['release-window-verify-rollback' as const],
        stopConditions: [stop('a-error-rate', 'error-rate', 0.01)],
      },
      {
        approval: 'required' as const,
        firstEnableCapability: 'none' as const,
        forwardCommandIds: ['release-window-activate' as const, 'monitor-release-window' as const],
        id: 'milestone-b' as const,
        metricIds: [...sharedMetrics],
        monitorDurationMinutes: 60,
        order: 2,
        ownerRole: 'platform-admin',
        prerequisites: ['milestone-a-stable'],
        rollbackCommandIds: ['release-window-rollback' as const],
        rollbackVerificationCommandIds: ['release-window-verify-rollback' as const],
        stopConditions: [stop('b-error-rate', 'error-rate', 0.01)],
      },
      {
        approval: 'required' as const,
        firstEnableCapability: 'connector-shared-credentials' as const,
        forwardCommandIds: [
          'flag-enable-connector-shared-credentials' as const,
          'monitor-release-window' as const,
        ],
        id: 'milestone-c' as const,
        metricIds: [...sharedMetrics],
        monitorDurationMinutes: 120,
        order: 3,
        ownerRole: 'security-admin',
        prerequisites: ['milestone-b-stable'],
        rollbackCommandIds: ['flag-disable-connector-shared-credentials' as const],
        rollbackVerificationCommandIds: ['release-window-verify-rollback' as const],
        stopConditions: [stop('c-error-rate', 'error-rate', 0.005)],
      },
      {
        approval: 'required' as const,
        firstEnableCapability: 'default-inbox' as const,
        forwardCommandIds: [
          'flag-enable-default-inbox' as const,
          'monitor-release-window' as const,
        ],
        id: 'milestone-d' as const,
        metricIds: [...sharedMetrics],
        monitorDurationMinutes: 120,
        order: 4,
        ownerRole: 'product-ops',
        prerequisites: ['milestone-c-stable'],
        rollbackCommandIds: ['flag-disable-default-inbox' as const],
        rollbackVerificationCommandIds: ['release-window-verify-rollback' as const],
        stopConditions: [stop('d-error-rate', 'error-rate', 0.005)],
      },
      {
        approval: 'required' as const,
        firstEnableCapability: 'oidc' as const,
        forwardCommandIds: ['flag-enable-oidc' as const, 'monitor-release-window' as const],
        id: 'milestone-e' as const,
        metricIds: [...sharedMetrics],
        monitorDurationMinutes: 180,
        order: 5,
        ownerRole: 'identity-admin',
        prerequisites: ['milestone-d-stable'],
        rollbackCommandIds: ['flag-disable-oidc' as const],
        rollbackVerificationCommandIds: ['release-window-verify-rollback' as const],
        stopConditions: [stop('e-auth-failure', 'auth-failure-rate', 0.02)],
      },
      {
        approval: 'required' as const,
        firstEnableCapability: 'branding-cutover' as const,
        forwardCommandIds: [
          'flag-enable-branding-cutover' as const,
          'monitor-release-window' as const,
        ],
        id: 'milestone-f' as const,
        metricIds: [...sharedMetrics],
        monitorDurationMinutes: 240,
        order: 6,
        ownerRole: 'release-manager',
        prerequisites: ['milestone-e-stable', 'dr-drill-passed'],
        rollbackCommandIds: ['flag-disable-branding-cutover' as const],
        rollbackVerificationCommandIds: [
          'release-window-verify-rollback' as const,
          'app-rollback-drill-production-authorized' as const,
        ],
        stopConditions: [stop('f-error-rate', 'error-rate', 0.005)],
      },
    ],
  };
};
