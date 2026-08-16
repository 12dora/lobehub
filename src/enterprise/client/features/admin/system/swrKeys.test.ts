import { describe, expect, it } from 'vitest';

import {
  ADMIN_SYSTEM_INSTANCES_KEY,
  ADMIN_SYSTEM_JOBS_KEY,
  ADMIN_SYSTEM_STATUS_KEY,
  buildAdminSystemInstancesKey,
  buildAdminSystemJobsKey,
  buildAdminSystemStatusKey,
} from './swrKeys';

describe('Admin System SWR permission gates', () => {
  it('returns null keys when SYSTEM_READ is unavailable', () => {
    expect(buildAdminSystemStatusKey(false)).toBeNull();
    expect(buildAdminSystemInstancesKey({ limit: 50 }, false)).toBeNull();
    expect(buildAdminSystemJobsKey({ limit: 50 }, false)).toBeNull();
  });

  it('keeps cursor and state inputs in enabled keys', () => {
    expect(buildAdminSystemStatusKey(true)).toEqual([ADMIN_SYSTEM_STATUS_KEY]);
    expect(
      buildAdminSystemInstancesKey({ cursor: 'instance-next', limit: 20, state: 'all' }, true),
    ).toEqual([ADMIN_SYSTEM_INSTANCES_KEY, { cursor: 'instance-next', limit: 20, state: 'all' }]);
    // Filter changes must produce a distinct key so pages are never mixed across row sets.
    expect(buildAdminSystemInstancesKey({ limit: 20, state: 'live' }, true)).not.toEqual(
      buildAdminSystemInstancesKey({ limit: 20, state: 'all' }, true),
    );
    expect(buildAdminSystemJobsKey({ cursor: 'job-next', limit: 20 }, true)).toEqual([
      ADMIN_SYSTEM_JOBS_KEY,
      { cursor: 'job-next', limit: 20 },
    ]);
  });
});
