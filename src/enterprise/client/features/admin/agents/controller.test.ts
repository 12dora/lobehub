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
    expect(deriveAdminAgentActionAvailability({ hasCurrentVersion: true, permissions })).toEqual({
      canArchiveNow: false,
      canAssign: false,
      canCreate: false,
      canEdit: false,
      canProvisionDefaultInbox: false,
      canSetDefaultNow: false,
    });
  });

  it.each([
    ['update without publish', [PLATFORM_PERMISSIONS.AGENT_UPDATE]],
    ['publish without update', [PLATFORM_PERMISSIONS.AGENT_PUBLISH]],
  ])('withholds Edit for %s — saving publishes, so it needs both', (_label, granted) => {
    const permissions = deriveAdminAgentPermissions(granted);
    expect(
      deriveAdminAgentActionAvailability({ hasCurrentVersion: true, permissions }).canEdit,
    ).toBe(false);
  });

  it.each([
    ['create without publish', [PLATFORM_PERMISSIONS.AGENT_CREATE]],
    ['publish without create', [PLATFORM_PERMISSIONS.AGENT_PUBLISH]],
  ])('withholds New assistant for %s — creating publishes too', (_label, granted) => {
    const permissions = deriveAdminAgentPermissions(granted);
    expect(
      deriveAdminAgentActionAvailability({ hasCurrentVersion: true, permissions }).canCreate,
    ).toBe(false);
  });

  it('opens every write once the compound permissions are granted', () => {
    const permissions = deriveAdminAgentPermissions([
      PLATFORM_PERMISSIONS.AGENT_CREATE,
      PLATFORM_PERMISSIONS.AGENT_UPDATE,
      PLATFORM_PERMISSIONS.AGENT_DELETE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
    ]);
    expect(deriveAdminAgentActionAvailability({ hasCurrentVersion: true, permissions })).toEqual({
      canArchiveNow: true,
      canAssign: false,
      canCreate: true,
      canEdit: true,
      // Creating an assistant is allowed here, but initializing the default one also assigns it.
      canProvisionDefaultInbox: false,
      canSetDefaultNow: true,
    });
  });

  it.each([
    [
      'create + publish, no assign',
      [PLATFORM_PERMISSIONS.AGENT_CREATE, PLATFORM_PERMISSIONS.AGENT_PUBLISH],
    ],
    [
      'create + assign, no publish',
      [PLATFORM_PERMISSIONS.AGENT_CREATE, PLATFORM_PERMISSIONS.AGENT_ASSIGN],
    ],
    [
      'publish + assign, no create',
      [PLATFORM_PERMISSIONS.AGENT_PUBLISH, PLATFORM_PERMISSIONS.AGENT_ASSIGN],
    ],
  ])(
    'withholds default-assistant initialization for %s — the server would only reject it',
    (_label, granted) => {
      const permissions = deriveAdminAgentPermissions(granted);
      expect(deriveAdminAgentActionAvailability({ permissions }).canProvisionDefaultInbox).toBe(
        false,
      );
    },
  );

  it('allows default-assistant initialization only with create + publish + assign', () => {
    const permissions = deriveAdminAgentPermissions([
      PLATFORM_PERMISSIONS.AGENT_CREATE,
      PLATFORM_PERMISSIONS.AGENT_PUBLISH,
      PLATFORM_PERMISSIONS.AGENT_ASSIGN,
    ]);
    expect(deriveAdminAgentActionAvailability({ permissions }).canProvisionDefaultInbox).toBe(true);
  });

  it('keeps the default-Inbox switch closed until a version exists', () => {
    const permissions = deriveAdminAgentPermissions([PLATFORM_PERMISSIONS.AGENT_PUBLISH]);
    expect(
      deriveAdminAgentActionAvailability({ hasCurrentVersion: false, permissions })
        .canSetDefaultNow,
    ).toBe(false);
  });
});
