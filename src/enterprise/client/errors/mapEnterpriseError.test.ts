import { describe, expect, it } from 'vitest';

import { mapEnterpriseError } from './mapEnterpriseError';

describe('mapEnterpriseError', () => {
  it('maps PLATFORM_* codes to contact_admin / retry actions', () => {
    expect(mapEnterpriseError({ message: 'PLATFORM_PERMISSION_DENIED' })).toMatchObject({
      action: 'contact_admin',
      code: 'PLATFORM_PERMISSION_DENIED',
    });
    expect(mapEnterpriseError('PLATFORM_REVISION_CONFLICT')).toMatchObject({
      action: 'retry',
      code: 'PLATFORM_REVISION_CONFLICT',
    });
  });

  it('maps ADMIN_REAUTH_REQUIRED', () => {
    expect(mapEnterpriseError({ message: 'ADMIN_REAUTH_REQUIRED' })).toMatchObject({
      action: 'reauth',
      code: 'ADMIN_REAUTH_REQUIRED',
    });
  });

  it('returns null for unknown free text', () => {
    expect(mapEnterpriseError({ message: 'something blew up' })).toBeNull();
  });
});
