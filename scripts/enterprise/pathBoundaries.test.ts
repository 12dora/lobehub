import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS,
  ENTERPRISE_PRODUCTION_IMPORT_ALLOWLIST,
  ENTERPRISE_TEST_IMPORT_ALLOWLIST,
  ENTERPRISE_UPSTREAM_MOUNT_POINTS,
  extractImportSpecifiers,
  findEnterpriseImportViolations,
  findPackageReverseImportViolations,
  isAllowedEnterpriseImporter,
  isAllowedEnterpriseProductionImport,
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
      'src/features/ProfileEditor/useManagedAgentSkills.ts',
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
    // Ordinary branding consumers are not whole-file mounts.
    expect(isAllowedEnterpriseImporter('src/layout/GlobalProvider/FaviconProvider.tsx')).toBe(
      false,
    );
    expect(isAllowedEnterpriseImporter('src/components/Branding/ProductLogo/index.tsx')).toBe(
      false,
    );
    // Tests are not file-level exempt — only exact (file, specifier) pairs.
    expect(
      isAllowedEnterpriseImporter(
        'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
      ),
    ).toBe(false);
    expect(isAllowedEnterpriseImporter('src/features/Chat/index.test.tsx')).toBe(false);
  });

  it('extracts import / require / side-effect / mock static string specifiers', () => {
    const src = `
      import x from '@/enterprise/client';
      const y = await import('@/server/enterprise/routers/platform');
      require('@/server/enterprise/featureFlags');
      import '@/enterprise/client/side-effect';
      vi.mock('@/server/enterprise/security/secret', () => ({}));
      vi.doMock('@/server/enterprise/services/aiCatalog');
      jest.mock('@/enterprise/client/providers');
      jest.doMock('@/server/enterprise/observability');
    `;
    expect(extractImportSpecifiers(src)).toEqual([
      '@/enterprise/client',
      '@/server/enterprise/routers/platform',
      '@/server/enterprise/featureFlags',
      '@/enterprise/client/side-effect',
      '@/server/enterprise/security/secret',
      '@/server/enterprise/services/aiCatalog',
      '@/enterprise/client/providers',
      '@/server/enterprise/observability',
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

  describe('scan roots include e2e and other source trees', () => {
    it('exports e2e among audited repository source/test roots', () => {
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS).toContain('e2e');
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS).toContain('src');
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS).toContain('apps/server/src');
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS).toContain('apps/desktop/src');
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS).toContain('apps/cli/src');
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS).toContain('packages');
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS).toContain('scripts/enterprise');
      // Do not silently widen to generated trees via this constant.
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS as readonly string[]).not.toContain(
        'node_modules',
      );
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS as readonly string[]).not.toContain('dist');
      expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS as readonly string[]).not.toContain('.next');
    });

    it('flags a new e2e enterprise import that is not registered (scan-root regression)', () => {
      const violations = findEnterpriseImportViolations([
        {
          path: 'e2e/src/identity-provider/newArbitrarySeed.ts',
          source: `import { PlatformSecretService } from '@/server/enterprise/security/secret';`,
        },
        {
          // Existing audited e2e seed remains allowed for its registered pair only.
          path: 'e2e/src/identity-provider/seedIdentityProvider.ts',
          source: `
            import { PlatformSecretService } from '@/server/enterprise/security/secret';
            import { parsePublishedIdentityProviderPayload } from '@/server/enterprise/services/identityProvider/publicationService';
          `,
        },
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'e2e/src/identity-provider/newArbitrarySeed.ts',
        importSpecifier: '@/server/enterprise/security/secret',
      });
    });
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
          source: `
            import { withActiveUserWhenManagedAgents } from '@/server/enterprise/guards/activeUser';
            vi.mock('@/server/enterprise/services/agentCatalog', async () => ({}));
          `,
        },
      ]);
      expect(violations).toEqual([]);
    });

    it('rejects an arbitrary new test that imports enterprise via from (negative)', () => {
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
    });

    it.each([
      ['side-effect import', `import '@/server/enterprise/security/secret';`],
      ['vi.mock', `vi.mock('@/server/enterprise/security/secret', () => ({}));`],
      ['vi.doMock', `vi.doMock('@/server/enterprise/security/secret');`],
      ['jest.mock', `jest.mock('@/server/enterprise/security/secret');`],
      ['jest.doMock', `jest.doMock('@/server/enterprise/security/secret');`],
    ] as const)('rejects arbitrary test using %s (negative)', (_label, source) => {
      const violations = findEnterpriseImportViolations([
        {
          path: 'src/features/Chat/arbitraryMockBypass.test.ts',
          source,
        },
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'src/features/Chat/arbitraryMockBypass.test.ts',
        importSpecifier: '@/server/enterprise/security/secret',
      });
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

  describe('production exact allowlist for ordinary branding consumers', () => {
    it('registers ordinary branding consumers with exact RuntimeBrandingProvider pairs only', () => {
      expect(ENTERPRISE_PRODUCTION_IMPORT_ALLOWLIST.length).toBeGreaterThan(0);
      for (const entry of ENTERPRISE_PRODUCTION_IMPORT_ALLOWLIST) {
        expect(entry.file).not.toMatch(/[*?]/);
        expect(entry.importSpecifier).not.toMatch(/[*?]/);
        expect(entry.owner.length).toBeGreaterThan(0);
        expect(entry.reason.length).toBeGreaterThan(0);
      }

      // Not whole-file mounts.
      for (const file of [
        'src/layout/GlobalProvider/FaviconProvider.tsx',
        'src/components/Branding/ProductLogo/index.tsx',
        'src/hooks/useDefaultInboxDisplayName.ts',
        'src/features/AuthShell/AuthContainer.tsx',
        'src/features/RouteMeta/RouteMetaBridge.tsx',
        'src/routes/(desktop)/desktop-onboarding/_layout/index.tsx',
      ] as const) {
        expect(ENTERPRISE_UPSTREAM_MOUNT_POINTS as readonly string[]).not.toContain(file);
      }

      expect(
        isAllowedEnterpriseProductionImport(
          'src/layout/GlobalProvider/FaviconProvider.tsx',
          '@/enterprise/client/providers/RuntimeBrandingProvider',
        ),
      ).toBe(true);
    });

    it('allows the audited branding import but rejects unrelated server enterprise secret (negative)', () => {
      const violations = findEnterpriseImportViolations([
        {
          path: 'src/layout/GlobalProvider/FaviconProvider.tsx',
          source: `
            import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
            import { PlatformSecretService } from '@/server/enterprise/security/secret';
          `,
        },
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        file: 'src/layout/GlobalProvider/FaviconProvider.tsx',
        importSpecifier: '@/server/enterprise/security/secret',
      });
    });

    it('allows legitimate branding-only consumers (positive)', () => {
      const violations = findEnterpriseImportViolations([
        {
          path: 'src/components/Branding/ProductLogo/index.tsx',
          source: `import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';`,
        },
        {
          path: 'src/features/RouteMeta/RouteMetaBridge.tsx',
          source: `import { useBranding } from '@/enterprise/client';`,
        },
      ]);
      expect(violations).toEqual([]);
    });
  });
});

describe('enterprise path-boundary CLI fail-closed coverage', () => {
  const script = path.join(process.cwd(), 'scripts/enterprise/check-path-boundaries.ts');

  it('fails when CWD is not the monorepo root (zero coverage)', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'path-boundary-cwd-'));
    try {
      const result = spawnSync('bun', ['run', script], {
        cwd: empty,
        encoding: 'utf8',
        env: { ...process.env },
      });
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /not a repository root|zero files scanned|missing or unreadable/i,
      );
    } finally {
      rmSync(empty, { force: true, recursive: true });
    }
  });

  it('lists mandatory scan roots for coverage contracts', () => {
    expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS.length).toBeGreaterThan(0);
    expect(ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS).toContain('scripts/enterprise');
  });
});
