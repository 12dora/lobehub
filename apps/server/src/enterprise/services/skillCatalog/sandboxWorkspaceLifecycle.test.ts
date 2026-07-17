import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  cleanupSandboxSkillWorkspace,
  createSandboxSkillWorkspaceRoot,
  sweepExpiredSandboxSkillWorkspaces,
} from './sandboxWorkspaceLifecycle';

describe('sandbox Skill workspace lifecycle', () => {
  it('creates an opaque timestamped workspace marker without exposing the operation id', () => {
    const operationId = 'sensitive-operation-id';
    const auditId = createHash('sha256').update(operationId).digest('hex').slice(0, 24);

    const result = createSandboxSkillWorkspaceRoot(operationId, {
      now: () => 1234,
      uuid: () => 'workspace-uuid',
    });

    expect(result).toEqual({
      auditId,
      root: `/tmp/lobe-managed-skills/ws-1234-${auditId}-workspace-uuid`,
    });
    expect(result.root).not.toContain(operationId);
  });

  it('retries cleanup when the sandbox reports success false', async () => {
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({ success: false })
      .mockResolvedValueOnce({ success: true });

    await expect(
      cleanupSandboxSkillWorkspace({
        auditId: 'opaque-audit-id',
        root: '/tmp/lobe-managed-skills/ws-1234-hash-uuid',
        sandbox: { callTool },
      }),
    ).resolves.toBe(true);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('leaves the timestamp marker for a later sweep after bounded cleanup retries', async () => {
    const callTool = vi.fn().mockResolvedValue({ success: false });

    await expect(
      cleanupSandboxSkillWorkspace({
        auditId: 'opaque-audit-id',
        root: '/tmp/lobe-managed-skills/ws-1234-hash-uuid',
        sandbox: { callTool },
      }),
    ).resolves.toBe(false);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('runs a bounded TTL sweep for workspaces orphaned by process interruption', async () => {
    const callTool = vi.fn().mockResolvedValue({ success: true });

    await expect(sweepExpiredSandboxSkillWorkspaces({ callTool })).resolves.toBe(true);
    const command = String(callTool.mock.calls[0][1].command);
    expect(command).toContain("-name '\\''ws-[0-9]*-[a-f0-9]*-*'\\''");
    expect(command).toContain('-mmin +240');
    expect(command).toContain('"$count" -lt 32');
    expect(command).not.toContain('sensitive-operation-id');
  });
});
