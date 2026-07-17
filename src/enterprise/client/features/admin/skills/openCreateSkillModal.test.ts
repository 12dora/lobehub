import { describe, expect, it, vi } from 'vitest';

import {
  AdminReauthBlockedError,
  AdminReauthCancelledError,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { runCreateSkillSubmission } from './openCreateSkillModal';
import type { AdminSkillCreateInput } from './types';

const input = (override: boolean): AdminSkillCreateInput => ({
  allowBuiltinOverride: override,
  description: null,
  displayName: 'Safe Skill',
  distribution: 'default',
  enabled: true,
  reason: 'approved reason',
  skillKey: 'safe.skill',
});

describe('M08 built-in override reauth submission', () => {
  it('bypasses reauth for ordinary Skill creation', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const runReauth = vi.fn();
    await runCreateSkillSubmission(input(false), submit, { runReauth });
    expect(runReauth).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(input(false));
  });

  it.each([
    ['cancel', new AdminReauthCancelledError()],
    ['blocked', new AdminReauthBlockedError()],
  ])('does not submit when override reauth is %s', async (_case, failure) => {
    const submit = vi.fn();
    const runReauth = vi.fn().mockRejectedValue(failure);
    await expect(
      runCreateSkillSubmission(input(true), submit, { authMethod: 'oidc', runReauth }),
    ).rejects.toBe(failure);
    expect(submit).not.toHaveBeenCalled();
  });

  it('reuses the exact frozen override payload when reauth succeeds', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const runReauth = vi.fn(async (commit: () => Promise<void>) => commit());
    const mutable = input(true);
    const promise = runCreateSkillSubmission(mutable, submit, {
      authMethod: 'oidc',
      runReauth,
    });
    mutable.reason = 'drifted reason';
    await promise;
    expect(runReauth).toHaveBeenCalledWith(expect.any(Function), { authMethod: 'oidc' });
    expect(submit).toHaveBeenCalledWith(input(true));
  });
});
