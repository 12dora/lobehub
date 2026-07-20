import { describe, expect, it } from 'vitest';

import {
  ENTERPRISE_TEST_IMPORT_ALLOWLIST,
  ENTERPRISE_UPSTREAM_MOUNT_POINTS,
  extractImportSpecifiers,
  findEnterpriseImportViolations,
  findPackageReverseImportViolations,
  isAllowedEnterpriseImporter,
  isAllowedEnterpriseTestImport,
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
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain(
      'src/app/(backend)/oauth/connector/callback/route.ts',
    );
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain(
      'apps/server/src/services/toolExecution/serverRuntimes/skills.ts',
    );
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain('apps/server/src/routers/tools/market.ts');
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain(
      'src/routes/(main)/settings/skill/features/PlatformSkillList.tsx',
    );
    expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS).toContain(
      'src/features/PlatformConnectorAuthorization/enterpriseAdapter.ts',
    );
    expect(
      ENTERPRISE_UPSTREAM_MOUNT_POINTS.filter((path) =>
        path.startsWith('src/features/PlatformConnectorAuthorization/'),
      ),
    ).toEqual(['src/features/PlatformConnectorAuthorization/enterpriseAdapter.ts']);
  });

  it('treats enterprise trees as owned', () => {
    expect(isEnterpriseOwnedPath('src/enterprise/client/index.ts')).toBe(true);
    expect(isEnterpriseOwnedPath('apps/server/src/enterprise/routers/platform.ts')).toBe(true);
    expect(isEnterpriseOwnedPath('packages/const/src/platform/errorCodes.ts')).toBe(true);
    expect(isEnterpriseOwnedPath('src/features/Chat/index.tsx')).toBe(false);
  });

  it('allows only mount points outside enterprise trees to import enterprise at file level', () => {
    expect(isAllowedEnterpriseImporter('src/business/client/BusinessGlobalProvider.tsx')).toBe(
      true,
    );
    expect(isAllowedEnterpriseImporter('src/features/Chat/index.tsx')).toBe(false);
    // Tests are not file-level exempt — only exact (file, specifier) pairs.
    expect(
      isAllowedEnterpriseImporter(
        'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
      ),
    ).toBe(false);
    expect(isAllowedEnterpriseImporter('src/features/Chat/index.test.tsx')).toBe(false);
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

  describe('test import allowlist (no global *.test.* / __tests__ exemption)', () => {
    it('registers only exact file+specifier pairs with reason and owner', () => {
      expect(ENTERPRISE_TEST_IMPORT_ALLOWLIST.length).toBeGreaterThan(0);
      for (const entry of ENTERPRISE_TEST_IMPORT_ALLOWLIST) {
        expect(entry.file.length).toBeGreaterThan(0);
        expect(entry.importSpecifier.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(0);
        expect(entry.owner.length).toBeGreaterThan(0);
        // No wildcard patterns in file paths or specifiers.
        expect(entry.file).not.toMatch(/[*?]/);
        expect(entry.importSpecifier).not.toMatch(/[*?]/);
      }
    });

    it('allows audited test-support pairs (positive)', () => {
      expect(
        isAllowedEnterpriseTestImport(
          'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
          '@/enterprise/client/services/userSettings',
        ),
      ).toBe(true);

      const violations = findEnterpriseImportViolations([
        {
          path: 'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
          source: `
            import * as enterprisePlatformModule from '@/enterprise/client/providers/EnterprisePlatformProvider';
            import { userSettingsService } from '@/enterprise/client/services/userSettings';
            import type { UserSettingsGetEffectiveOutput } from '@/server/enterprise/contracts/userSettings';
          `,
        },
        {
          path: 'apps/server/src/routers/lambda/__tests__/managedAgentActiveUser.guard.test.ts',
          source: `import { withActiveUserWhenManagedAgents } from '@/server/enterprise/guards/activeUser';`,
        },
      ]);
      expect(violations).toEqual([]);
    });

    it('rejects an arbitrary new test that imports enterprise (negative)', () => {
      const violations = findEnterpriseImportViolations([
        {
          path: 'src/features/Chat/arbitraryNewBoundary.test.ts',
          source: `import { x } from '@/enterprise/client/providers/EnterprisePlatformProvider';`,
        },
        {
          path: 'apps/server/src/services/foo/__tests__/sneaky.test.ts',
          source: `import { PlatformSecretService } from '@/server/enterprise/security/secret';`,
        },
      ]);
      expect(violations).toHaveLength(2);
      expect(violations.map((v) => v.file).sort()).toEqual([
        'apps/server/src/services/foo/__tests__/sneaky.test.ts',
        'src/features/Chat/arbitraryNewBoundary.test.ts',
      ]);
    });

    it('rejects allowlisted test file with a non-allowlisted specifier (negative)', () => {
      const violations = findEnterpriseImportViolations([
        {
          path: 'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
          source: `
            import { userSettingsService } from '@/enterprise/client/services/userSettings';
            import { secretInternals } from '@/server/enterprise/security/secret';
          `,
        },
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
        importSpecifier: '@/server/enterprise/security/secret',
      });
    });

    it('does not treat bare __tests__ path or *.test.* suffix as file-level free pass', () => {
      expect(isAllowedEnterpriseImporter('src/anything/__tests__/helper.ts')).toBe(false);
      expect(isAllowedEnterpriseImporter('src/anything/foo.test.ts')).toBe(false);
      expect(isAllowedEnterpriseImporter('apps/server/src/routers/lambda/__tests__/x.ts')).toBe(
        false,
      );

      const violations = findEnterpriseImportViolations([
        {
          path: 'src/anything/__tests__/helper.ts',
          source: `import { x } from '@/enterprise/client';`,
        },
        {
          path: 'src/anything/foo.test.ts',
          source: `import { x } from '@/server/enterprise/featureFlags';`,
        },
      ]);
      expect(violations).toHaveLength(2);
    });
  });
});
