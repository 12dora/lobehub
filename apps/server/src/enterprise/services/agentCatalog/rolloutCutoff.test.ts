// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { PlatformJobItem } from '@/database/schemas/platform';

import { PlatformAgentInvalidInputError } from './errors';
import { parsePlatformAgentRolloutInput } from './rolloutService';

const jobWithCutoff = (targetCutoff: string) =>
  ({
    input: {
      control: { phase: 'targets', revision: 0 },
      snapshot: {
        agentId: 'agent',
        assignmentId: 'assignment',
        previousVersionChecksum: null,
        previousVersionId: null,
        rollbackOfJobId: null,
        targetCutoff,
        targetId: '__global__',
        targetType: 'global',
        targetVersionChecksum: 'a'.repeat(64),
        targetVersionId: 'version',
        versionPolicy: 'latest_published',
      },
    },
  }) as unknown as PlatformJobItem;

describe('platform Agent rollout cutoff contract', () => {
  it('preserves exactly six UTC fractional digits and rejects millisecond truncation', () => {
    const cutoff = '2000-01-01T00:00:00.123456Z';
    expect(parsePlatformAgentRolloutInput(jobWithCutoff(cutoff)).snapshot.targetCutoff).toBe(
      cutoff,
    );
    expect(() => parsePlatformAgentRolloutInput(jobWithCutoff('2000-01-01T00:00:00.123Z'))).toThrow(
      PlatformAgentInvalidInputError,
    );
  });
});
