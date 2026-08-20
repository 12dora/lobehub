// @vitest-environment node
/**
 * Isolated from agentTemplates.test.ts so the router module is evaluated under the spy
 * (vitest gives each file its own module cache).
 *
 * Importing the router graph will still cause Node/Vite to `readFileSync` node_modules
 * (CJS interop). The regression this guards is *application* catalog I/O: a source-tree
 * locales/.../suggestQuestions.json read at module evaluation, which blows up the
 * standalone Docker bundle.
 */
import fs from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

describe('admin.agentTemplates module load', () => {
  it('does not read the filesystem when the router module is imported', async () => {
    const spy = vi.spyOn(fs, 'readFileSync');
    try {
      await import('./agentTemplates');
      const catalogReads = spy.mock.calls
        .map(([filePath]) => String(filePath))
        .filter(
          (filePath) =>
            filePath.includes('suggestQuestions') || filePath.includes('builtInAgentTemplates'),
        );
      expect(catalogReads).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
