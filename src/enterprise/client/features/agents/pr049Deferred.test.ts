import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PR049_MANAGED_AGENT_STATUS } from './index';

const ENTERPRISE_ROOT = path.join(process.cwd(), 'src', 'enterprise');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

describe('PR-049 ordinary-user managed-Agent presentation is deferred', () => {
  it('is explicitly marked deferred', () => {
    expect(PR049_MANAGED_AGENT_STATUS).toBe('deferred');
  });

  it('has no production caller wiring it into runtime (only self + tests may reference it)', () => {
    const offenders = walk(ENTERPRISE_ROOT)
      .filter((file) => /\.(?:ts|tsx)$/.test(file))
      .filter((file) => !file.includes(path.join('features', 'agents')))
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return (
          /features\/agents['"]/.test(source) ||
          /getPlatformAgentPresentation|PlatformAgentManagementNotice/.test(source)
        );
      });
    expect(offenders).toEqual([]);
  });
});
