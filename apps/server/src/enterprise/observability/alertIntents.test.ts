import { describe, expect, it } from 'vitest';

import { ENTERPRISE_ALERT_INTENTS } from './alertIntents';

describe('enterprise alert intents', () => {
  it('defines backend-neutral inactive intents for the five operational risks', () => {
    expect(ENTERPRISE_ALERT_INTENTS.map(({ key }) => key)).toEqual([
      'publish_failure_ratio',
      'publish_conflict_ratio',
      'invalidation_degraded',
      'cache_failure_rate',
      'guard_denial_spike',
      'heartbeat_failure',
    ]);
    expect(ENTERPRISE_ALERT_INTENTS.every(({ status }) => status === 'intent-only')).toBe(true);
  });
});
