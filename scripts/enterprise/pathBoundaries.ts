/**
 * Pure path-boundary rules for AIHub enterprise code.
 * Used by CLI and unit tests.
 */

/** Upstream files allowed to import enterprise mounts (stable seams). */
export const ENTERPRISE_UPSTREAM_MOUNT_POINTS = [
  'src/business/client/BusinessDesktopRoutes.tsx',
  'src/business/client/BusinessGlobalProvider.tsx',
  'apps/server/src/routers/lambda/index.ts',
] as const;

/** Paths where enterprise implementation is allowed freely. */
export const ENTERPRISE_OWNED_PATH_PREFIXES = [
  'src/enterprise/',
  'apps/server/src/enterprise/',
  'packages/const/src/platform/',
  'packages/types/src/platform/',
  'docs/enterprise-patches/',
  'docs/redevelopment/',
  'scripts/enterprise/',
] as const;

/**
 * Owned by M01 parallel workstream — M00 must not create these.
 * CI still allows them if present (other worktree), but flags new M00 commits via policy docs.
 */
export const M01_OWNED_PATH_PREFIXES = [
  'packages/database/src/schemas/platform/',
  'packages/database/src/models/platform/',
] as const;

/** Import path prefixes that count as "enterprise" dependencies. */
export const ENTERPRISE_IMPORT_MARKERS = [
  '@/enterprise/',
  '@/server/enterprise/',
  'src/enterprise/',
  'apps/server/src/enterprise/',
] as const;

export const normalizeRepoPath = (filePath: string): string =>
  filePath.replaceAll('\\', '/').replace(/^\.\//, '');

export const isEnterpriseOwnedPath = (filePath: string): boolean => {
  const path = normalizeRepoPath(filePath);
  return ENTERPRISE_OWNED_PATH_PREFIXES.some(
    (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
  );
};

export const isAllowedUpstreamMountPoint = (filePath: string): boolean => {
  const path = normalizeRepoPath(filePath);
  return (ENTERPRISE_UPSTREAM_MOUNT_POINTS as readonly string[]).includes(path);
};

export const isAllowedEnterpriseImporter = (filePath: string): boolean =>
  isEnterpriseOwnedPath(filePath) ||
  isAllowedUpstreamMountPoint(filePath) ||
  // tests colocated with mounts
  /\/__tests__\//.test(normalizeRepoPath(filePath)) ||
  /\.test\.[cm]?[jt]sx?$/.test(normalizeRepoPath(filePath));

const IMPORT_RE =
  /from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export const extractImportSpecifiers = (source: string): string[] => {
  const specs: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) specs.push(spec);
  }
  return specs;
};

export const isEnterpriseImport = (specifier: string): boolean =>
  ENTERPRISE_IMPORT_MARKERS.some(
    (marker) => specifier === marker.slice(0, -1) || specifier.startsWith(marker),
  );

export interface PathBoundaryViolation {
  file: string;
  importSpecifier: string;
  reason: string;
}

export const findEnterpriseImportViolations = (
  files: Array<{ path: string; source: string }>,
): PathBoundaryViolation[] => {
  const violations: PathBoundaryViolation[] = [];

  for (const file of files) {
    if (isAllowedEnterpriseImporter(file.path)) continue;

    for (const spec of extractImportSpecifiers(file.source)) {
      if (!isEnterpriseImport(spec)) continue;
      violations.push({
        file: normalizeRepoPath(file.path),
        importSpecifier: spec,
        reason:
          'Only enterprise-owned paths and allowlisted upstream mount points may import enterprise modules',
      });
    }
  }

  return violations;
};

/**
 * Detect reverse dependency: shared packages must not import SPA enterprise client code.
 */
export const findPackageReverseImportViolations = (
  files: Array<{ path: string; source: string }>,
): PathBoundaryViolation[] => {
  const violations: PathBoundaryViolation[] = [];

  for (const file of files) {
    const path = normalizeRepoPath(file.path);
    if (!path.startsWith('packages/')) continue;
    // platform packages may exist under const/types — still must not import client
    for (const spec of extractImportSpecifiers(file.source)) {
      if (
        spec.startsWith('@/enterprise/') ||
        spec.includes('src/enterprise/') ||
        spec.startsWith('@/server/enterprise/')
      ) {
        violations.push({
          file: path,
          importSpecifier: spec,
          reason: 'packages/* must not import enterprise client/server SPA paths',
        });
      }
    }
  }

  return violations;
};
