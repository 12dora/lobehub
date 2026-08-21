// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { projectSandboxHealth } from './sandboxProbe';

const checkedAt = new Date('2026-08-21T00:00:00.000Z');

describe('projectSandboxHealth', () => {
  it('marks an unreachable daemon as unavailable', () => {
    expect(
      projectSandboxHealth(
        {
          activeContainers: 0,
          daemonReachable: false,
          imagePresent: false,
          lastError: 'connect ECONNREFUSED',
        },
        8,
        checkedAt,
      ),
    ).toMatchObject({
      daemonReachable: false,
      errorCategory: 'operation_unavailable',
      imagePresent: false,
      maxContainers: 8,
      status: 'unavailable',
    });
  });

  it('marks a missing image as degraded', () => {
    expect(
      projectSandboxHealth(
        { activeContainers: 0, daemonReachable: true, imagePresent: false },
        8,
        checkedAt,
      ),
    ).toMatchObject({
      daemonReachable: true,
      errorCategory: 'configuration_incomplete',
      imagePresent: false,
      status: 'degraded',
    });
  });

  it('is healthy when the daemon and image are present', () => {
    expect(
      projectSandboxHealth(
        { activeContainers: 3, daemonReachable: true, imagePresent: true },
        8,
        checkedAt,
      ),
    ).toEqual({
      activeContainers: 3,
      daemonReachable: true,
      errorCategory: null,
      imagePresent: true,
      lastCheckedAt: checkedAt,
      maxContainers: 8,
      status: 'healthy',
    });
  });
});
