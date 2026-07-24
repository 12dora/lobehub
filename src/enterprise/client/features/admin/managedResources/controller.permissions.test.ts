import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';

import { deriveManagedResourcePermissions } from './controller';

/**
 * Permission combinations for the managed-resources surface:
 * - POLICY_READ gates the policy matrix fetch
 * - CONNECTOR_READ reaches nested shared-OAuth without POLICY_READ (parent OR-gate)
 * - POLICY_UPDATE / CONNECTOR_UPDATE are independent write gates
 */
describe('managed resource permission combinations', () => {
  it('policy-read-only can view but not update or publish', () => {
    expect(deriveManagedResourcePermissions([PLATFORM_PERMISSIONS.POLICY_READ])).toEqual({
      canPublish: false,
      canUpdate: false,
      canView: true,
    });
  });

  it('connector-only administrator has no policy view/update/publish', () => {
    // Parent page still renders for CONNECTOR_READ; policy permissions stay false.
    expect(
      deriveManagedResourcePermissions([
        PLATFORM_PERMISSIONS.CONNECTOR_READ,
        PLATFORM_PERMISSIONS.CONNECTOR_UPDATE,
      ]),
    ).toEqual({
      canPublish: false,
      canUpdate: false,
      canView: false,
    });
  });

  it('policy update without publish can save drafts but not publish', () => {
    expect(
      deriveManagedResourcePermissions([
        PLATFORM_PERMISSIONS.POLICY_READ,
        PLATFORM_PERMISSIONS.POLICY_UPDATE,
      ]),
    ).toEqual({
      canPublish: false,
      canUpdate: true,
      canView: true,
    });
  });

  it('full policy admin can view, update, and publish', () => {
    expect(
      deriveManagedResourcePermissions([
        PLATFORM_PERMISSIONS.POLICY_READ,
        PLATFORM_PERMISSIONS.POLICY_UPDATE,
        PLATFORM_PERMISSIONS.POLICY_PUBLISH,
        PLATFORM_PERMISSIONS.CONNECTOR_READ,
      ]),
    ).toEqual({
      canPublish: true,
      canUpdate: true,
      canView: true,
    });
  });
});
