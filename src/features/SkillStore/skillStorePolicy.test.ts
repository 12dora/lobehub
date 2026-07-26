import { describe, expect, it, vi } from 'vitest';

import type { AdminToolScopeCapabilities } from '@/features/AdminToolScope';

import {
  resolveSkillImportCapability,
  resolveSkillStoreCapabilities,
  runSkillImport,
} from './skillStorePolicy';

const platformCapabilities = (
  overrides: Partial<AdminToolScopeCapabilities>,
): AdminToolScopeCapabilities => ({
  canCreateConnector: false,
  canCreateSkill: false,
  canDeleteConnector: false,
  canDeleteSkill: false,
  canUpdateConnector: false,
  canUpdateSkill: false,
  ...overrides,
});

describe('SkillStore platform policy', () => {
  it('makes MarketSkillItem platform RBAC override contradictory personal permissions', () => {
    expect(
      resolveSkillStoreCapabilities(
        platformCapabilities({ canCreateSkill: true, canDeleteSkill: false }),
        { canCreate: false, canDelete: true },
      ),
    ).toEqual({ canCreate: true, canDelete: false });

    expect(resolveSkillStoreCapabilities(undefined, { canCreate: false, canDelete: true })).toEqual(
      {
        canCreate: false,
        canDelete: true,
      },
    );
  });

  it('fails override import modals closed when platform create permission is absent', () => {
    expect(resolveSkillImportCapability(true, false, true)).toBe(false);
    expect(resolveSkillImportCapability(true, true, false)).toBe(true);
    expect(resolveSkillImportCapability(false, undefined, true)).toBe(true);
  });

  it('leaves override success and soft-failure notification ownership with the provider', async () => {
    const providerWarning = vi.fn();
    const genericSuccess = vi.fn();
    const close = vi.fn();

    await runSkillImport({
      importSkill: async () => {
        // A resolved soft publication failure has already been reported by the admin provider.
        providerWarning('saved as draft');
      },
      onComplete: close,
      onPersonalSuccess: genericSuccess,
      platformOverride: true,
    });

    expect(providerWarning).toHaveBeenCalledTimes(1);
    expect(genericSuccess).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps generic success for personal imports', async () => {
    const genericSuccess = vi.fn();
    const close = vi.fn();

    await runSkillImport({
      importSkill: vi.fn().mockResolvedValue(undefined),
      onComplete: close,
      onPersonalSuccess: genericSuccess,
      platformOverride: false,
    });

    expect(genericSuccess).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
