// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createEngineLogRing } from './logs';

describe('createEngineLogRing', () => {
  it('caps at max lines and redacts bearer tokens', () => {
    const ring = createEngineLogRing(3);
    ring.append('one\nAuthorization: Bearer super-secret-token\nthree\nfour');
    const lines = ring.get();
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('super-secret-token');
    expect(lines.at(-1)).toBe('four');
  });
});
