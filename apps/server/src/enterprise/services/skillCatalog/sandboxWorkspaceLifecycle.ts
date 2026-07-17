import { createHash, randomUUID } from 'node:crypto';

import debug from 'debug';

const log = debug('lobe-server:managed-skill-workspace');

const SANDBOX_WORKSPACE_BASE = '/tmp/lobe-managed-skills';
const SANDBOX_WORKSPACE_SWEEP_LIMIT = 32;
const SANDBOX_WORKSPACE_TTL_MINUTES = 240;
const CLEANUP_ATTEMPTS = 2;

interface SandboxCallResult {
  error?: { message?: string };
  success: boolean;
}

interface SandboxWorkspaceClient {
  callTool: (toolName: string, params: Record<string, unknown>) => Promise<SandboxCallResult>;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const createSandboxSkillWorkspaceRoot = (
  operationId: string,
  options?: { now?: () => number; uuid?: () => string },
) => {
  const operationHash = createHash('sha256').update(operationId).digest('hex').slice(0, 24);
  const createdAt = (options?.now ?? Date.now)();
  const workspaceId = (options?.uuid ?? randomUUID)();
  return {
    auditId: operationHash,
    root: `${SANDBOX_WORKSPACE_BASE}/ws-${createdAt}-${operationHash}-${workspaceId}`,
  };
};

export const sweepExpiredSandboxSkillWorkspaces = async (
  sandbox: SandboxWorkspaceClient,
): Promise<boolean> => {
  const script = [
    'set -o pipefail',
    'count=0',
    `while IFS= read -r -d '' dir && [ "$count" -lt ${SANDBOX_WORKSPACE_SWEEP_LIMIT} ]; do`,
    '  rm -rf -- "$dir"',
    '  count=$((count + 1))',
    'done < <(find ' +
      `${shellQuote(SANDBOX_WORKSPACE_BASE)} -mindepth 1 -maxdepth 1 -type d ` +
      `-name 'ws-[0-9]*-[a-f0-9]*-*' -mmin +${SANDBOX_WORKSPACE_TTL_MINUTES} -print0)`,
  ].join('\n');
  try {
    const result = await sandbox.callTool('runCommand', {
      command: `mkdir -p ${shellQuote(SANDBOX_WORKSPACE_BASE)} && bash -lc ${shellQuote(script)}`,
    });
    if (!result.success) log('expired managed Skill workspace sweep deferred');
    return result.success;
  } catch {
    log('expired managed Skill workspace sweep deferred');
    return false;
  }
};

export const cleanupSandboxSkillWorkspace = async (params: {
  auditId: string;
  root: string;
  sandbox: SandboxWorkspaceClient;
}): Promise<boolean> => {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      const result = await params.sandbox.callTool('runCommand', {
        command: `rm -rf ${shellQuote(params.root)}`,
      });
      if (result.success) return true;
    } catch {
      // Retry once; the timestamped root remains a durable TTL marker if both attempts fail.
    }
  }
  log('managed Skill workspace cleanup deferred audit=%s', params.auditId);
  return false;
};
