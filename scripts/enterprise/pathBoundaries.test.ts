import { describe, expect, it } from 'vitest';

import {
  ENTERPRISE_UPSTREAM_MOUNT_POINTS,
  extractImportSpecifiers,
  findEnterpriseImportViolations,
  findPackageReverseImportViolations,
  isAllowedEnterpriseImporter,
  isEnterpriseOwnedPath,
} from './pathBoundaries';

describe('enterprise path boundaries', () => {
  it('lists M00 upstream mount points including global config gate', () => {
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain(
      'src/business/client/BusinessDesktopRoutes.tsx',
    );
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain(
      'src/business/client/BusinessGlobalProvider.tsx',
    );
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain('apps/server/src/routers/lambda/index.ts');
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain('apps/server/src/globalConfig/index.ts');
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain('packages/types/src/serverConfig.ts');
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain('apps/server/src/routers/lambda/agent.ts');
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain(
      'apps/server/src/routers/lambda/connector.ts',
    );
  });

  it('treats enterprise trees as owned', () => {
    expect(isEnterpriseOwnedPath('src/enterprise/client/index.ts')).toBe(true);
    expect(isEnterpriseOwnedPath('apps/server/src/enterprise/routers/platform.ts')).toBe(true);
    expect(isEnterpriseOwnedPath('packages/const/src/platform/errorCodes.ts')).toBe(true);
    expect(isEnterpriseOwnedPath('src/features/Chat/index.tsx')).toBe(false);
  });

  it('allows only mount points outside enterprise trees to import enterprise', () => {
    expect(isAllowedEnterpriseImporter('src/business/client/BusinessGlobalProvider.tsx')).toBe(
      true,
    );
    expect(isAllowedEnterpriseImporter('src/features/Chat/index.tsx')).toBe(false);
  });

  it('extracts import specifiers', () => {
    const src = `
      import x from '@/enterprise/client';
      const y = await import('@/server/enterprise/routers/platform');
    `;
    expect(extractImportSpecifiers(src)).toEqual([
      '@/enterprise/client',
      '@/server/enterprise/routers/platform',
    ]);
  });

  it('flags illegal enterprise imports outside allowlist', () => {
    const violations = findEnterpriseImportViolations([
      {
        path: 'src/features/Foo.tsx',
        source: `import { x } from '@/enterprise/client';`,
      },
      {
        path: 'src/business/client/BusinessGlobalProvider.tsx',
        source: `import { EnterprisePlatformProvider } from '@/enterprise/client/providers';`,
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('src/features/Foo.tsx');
  });

  it('flags packages reverse-importing enterprise client', () => {
    const violations = findPackageReverseImportViolations([
      {
        path: 'packages/utils/src/foo.ts',
        source: `import { x } from '@/enterprise/client';`,
      },
    ]);
    expect(violations).toHaveLength(1);
  });
});
