import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('agent profile direct route', () => {
  it('keeps the legacy profile configuration URL behind the agents boundary', () => {
    const source = readFileSync('src/routes/(main)/agent/profile/index.tsx', 'utf8');

    expect(source).toContain('<ManagedResourceBoundary resource="agents">');
    expect(source).toContain('<ProfileProvider>');
  });
});
