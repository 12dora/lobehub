import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('Claude issue dedupe preflight', () => {
  it('keeps the dedupe preflight independent from the MCP submission handler executor', async () => {
    const source = await readFile(
      path.resolve(process.cwd(), '.github/scripts/should-run-dedupe.ts'),
      'utf8',
    );

    expect(source).toContain('./shared/mcp-submission-classifier');
    expect(source).not.toContain('./auto-handle-mcp-submission');
  });
});
