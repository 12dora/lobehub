import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { deriveAdminAgentActionAvailability, deriveAdminAgentPermissions } from './controller';

describe('deriveAdminAgentPermissions', () => {
  it('keeps auditor-style read permission strictly read only', () => {
    expect(deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_READ])).toEqual({
      canAssign: false,
      canCreate: false,
      canDelete: false,
      canPublish: false,
      canRead: true,
      canUpdate: false,
    });
  });

  it('checks each Agent mutation permission independently', () => {
    expect(
      deriveAdminAgentPermissions([
        PLATFORM_PERMISSIONS.AGENT_CREATE,
        PLATFORM_PERMISSIONS.AGENT_ASSIGN,
      ]),
    ).toEqual({
      canAssign: true,
      canCreate: true,
      canDelete: false,
      canPublish: false,
      canRead: false,
      canUpdate: false,
    });
  });

  it.each([
    [PLATFORM_PERMISSIONS.AGENT_CREATE, 'canCreate'],
    [PLATFORM_PERMISSIONS.AGENT_UPDATE, 'canUpdate'],
    [PLATFORM_PERMISSIONS.AGENT_DELETE, 'canDelete'],
    [PLATFORM_PERMISSIONS.AGENT_PUBLISH, 'canPublish'],
    [PLATFORM_PERMISSIONS.AGENT_ASSIGN, 'canAssign'],
  ] as const)('maps %s only to %s', (permission, capability) => {
    const derived = deriveAdminAgentPermissions([permission]);
    expect(derived[capability]).toBe(true);
    expect(
      Object.entries(derived)
        .filter(([key]) => key !== capability)
        .every(([, value]) => value === false),
    ).toBe(true);
  });

  it('keeps every detail write action hidden for a read-only auditor', () => {
    const permissions = deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_READ]);
    expect(
      deriveAdminAgentActionAvailability({ dirty: false, hasCurrentVersion: true, permissions }),
    ).toEqual({
      canArchiveNow: false,
      canAssign: false,
      canPublishNow: false,
      canRollbackNow: false,
      canSaveVersion: false,
    });
  });

  it('locks publish, rollback, and archive while a local version is dirty', () => {
    const permissions = deriveAdminAgentPermissions([
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_DELETE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ]);
    expect(
      deriveAdminAgentActionAvailability({ dirty: true, hasCurrentVersion: true, permissions }),
    ).toMatchObject({
      canArchiveNow: false,
      canPublishNow: false,
      canRollbackNow: false,
      canSaveVersion: true,
    });
  });
});
