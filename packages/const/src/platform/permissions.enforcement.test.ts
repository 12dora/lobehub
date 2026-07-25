import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS, type PlatformPermission } from './permissions';

/**
 * Walk *enforcement* surfaces only: enterprise routers + guards.
 *
 * Deliberately excludes `security/policy/adminProcedureAuthorization/entries.*`
 * (authorization *catalog* registration). A permission that is only listed in
 * the catalog but never attached to a procedure middleware would still appear
 * there — scanning it would not prove enforcement.
 */
const collectTsFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsFiles(full, out);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
};

const workspaceRoot = path.join(__dirname, '../../../..');
const enforcementRoots = [
  path.join(workspaceRoot, 'apps/server/src/enterprise/routers'),
  path.join(workspaceRoot, 'apps/server/src/enterprise/guards'),
];

describe('platform permission enforcement coverage', () => {
  it('every cataloged permission is enforced by at least one router or guard', () => {
    const sources = enforcementRoots.flatMap((root) => collectTsFiles(root));
    expect(sources.length).toBeGreaterThan(10);
    const corpus = sources.map((file) => readFileSync(file, 'utf8')).join('\n');

    const missing: PlatformPermission[] = [];
    for (const [key, code] of Object.entries(PLATFORM_PERMISSIONS) as Array<
      [keyof typeof PLATFORM_PERMISSIONS, PlatformPermission]
    >) {
      const bySymbol = corpus.includes(`PLATFORM_PERMISSIONS.${key}`);
      const byLiteral = corpus.includes(`'${code}'`) || corpus.includes(`"${code}"`);
      if (!bySymbol && !byLiteral) missing.push(code);
    }

    expect(missing, `permissions without router/guard enforcement: ${missing.join(', ')}`).toEqual(
      [],
    );
  });
});
