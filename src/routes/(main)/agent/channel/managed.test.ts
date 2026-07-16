import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('agent channel direct route', () => {
  it('keeps the legacy channel configuration URL behind the agents boundary', () => {
    const source = readFileSync('src/routes/(main)/agent/channel/index.tsx', 'utf8');

    expect(source).toContain('<ManagedResourceBoundary resource="agents">');
    expect(source).toContain('<ChannelConfiguration />');
  });
});
