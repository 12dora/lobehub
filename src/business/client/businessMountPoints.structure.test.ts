import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract: business mount points stay declarative one-line bindings.
 * Heavy logic must live under `src/enterprise` (or package `lib/` implementations).
 */
const BUSINESS_CLIENT = path.join(__dirname);
const BUSINESS_SERVER = path.join(__dirname, '../server');
const BUSINESS_PACKAGES = path.join(__dirname, '../../../packages/business');

const read = (absolute: string) => readFileSync(absolute, 'utf8');

const nonCommentLines = (source: string) =>
  source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));

/** True when the file is only re-exports / thin wrappers (no function bodies / hooks). */
const isThinMount = (source: string): boolean => {
  const lines = nonCommentLines(source);
  if (lines.length === 0) return false;
  // Allow only import/export and trivial type-only lines.
  return lines.every(
    (line) =>
      line.startsWith('import ') ||
      line.startsWith('export ') ||
      line.startsWith('export{') ||
      line.startsWith('export type ') ||
      line.startsWith('export interface ') ||
      line === '}' ||
      line === '};' ||
      line.startsWith('type ') ||
      line.startsWith('interface '),
  );
};

describe('business client mount-point thinness', () => {
  it('BusinessDesktopRoutes is a declarative re-export of enterprise routes', () => {
    const src = read(path.join(BUSINESS_CLIENT, 'BusinessDesktopRoutes.tsx'));
    expect(src).toMatch(/EnterpriseDesktopRoutesWithoutMainLayout/);
    expect(src).not.toMatch(/createAdminRouteTree|AdminRootGate/);
    expect(nonCommentLines(src).length).toBeLessThan(25);
  });

  it('BusinessMobileRoutes is a declarative re-export of enterprise mobile routes', () => {
    const src = read(path.join(BUSINESS_CLIENT, 'BusinessMobileRoutes.tsx'));
    expect(src).toMatch(/getEnterpriseMobileRoutesWithoutMainLayout/);
    expect(src).not.toMatch(/AdminMobileUnsupportedSurface/);
    expect(nonCommentLines(src).length).toBeLessThan(20);
  });

  it('BusinessGlobalProvider is a one-line enterprise composition mount', () => {
    const src = read(path.join(BUSINESS_CLIENT, 'BusinessGlobalProvider.tsx'));
    expect(src).toMatch(/EnterpriseBusinessGlobalProvider/);
    expect(src).not.toMatch(/useLayoutEffect|useAgentStore/);
    expect(nonCommentLines(src).length).toBeLessThan(15);
  });

  it('DefaultInboxBrandingSync re-exports enterprise implementation', () => {
    const src = read(path.join(BUSINESS_CLIENT, 'DefaultInboxBrandingSync.tsx'));
    expect(src).toMatch(/enterprise\/client\/features\/branding\/DefaultInboxBrandingSync/);
    expect(nonCommentLines(src).length).toBeLessThan(10);
  });

  it('useHeteroAgentCloudConfig is a thin enterprise re-export', () => {
    const src = read(path.join(BUSINESS_CLIENT, 'hooks/useHeteroAgentCloudConfig.ts'));
    expect(src).toMatch(/enterprise\/client\/hooks\/useHeteroAgentCloudConfig/);
    expect(isThinMount(src)).toBe(true);
  });
});

describe('business server mount-point thinness', () => {
  it('bot/featureAccess is a thin enterprise re-export', () => {
    const src = read(path.join(BUSINESS_SERVER, 'bot/featureAccess.ts'));
    expect(src).toMatch(/enterprise\/server\/bot\/featureAccess/);
    expect(isThinMount(src)).toBe(true);
  });
});

describe('packages/business public mounts stay thin re-exports', () => {
  const publicMounts = [
    path.join(BUSINESS_PACKAGES, 'config/src/llm.ts'),
    path.join(BUSINESS_PACKAGES, 'model-bank/src/model-config.ts'),
    path.join(BUSINESS_PACKAGES, 'model-runtime/src/model-mapping.ts'),
    path.join(BUSINESS_PACKAGES, 'model-runtime/src/router-runtime-options.ts'),
  ];

  it.each(publicMounts)('%s is a one-line re-export of lib implementation', (file) => {
    const src = read(file);
    expect(src).toMatch(/from ['"]\.\/lib\//);
    expect(isThinMount(src)).toBe(true);
    expect(nonCommentLines(src).length).toBeLessThanOrEqual(3);
  });

  it('does not keep substantial implementation on public entry files', () => {
    for (const file of publicMounts) {
      const src = read(file);
      expect(src).not.toMatch(/function |=> \{|Record<any/);
    }
  });
});
