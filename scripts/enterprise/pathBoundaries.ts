/**
 * Pure path-boundary rules for AIHub enterprise code.
 * Used by CLI and unit tests.
 */

/** Upstream files allowed to import enterprise mounts (stable seams). */
export const ENTERPRISE_UPSTREAM_MOUNT_POINTS = [
  'src/business/client/BusinessDesktopRoutes.tsx',
  'src/business/client/BusinessGlobalProvider.tsx',
  // M03: mobile /admin deep-link unsupported surface
  'src/business/client/BusinessMobileRoutes.tsx',
  'apps/server/src/routers/lambda/index.ts',
  // M00 mount #4: enterprise gate on GlobalServerConfig
  'apps/server/src/globalConfig/index.ts',
  'packages/types/src/serverConfig.ts',
  // M04: block Better Auth admin plugin mutations when platform admin is on
  'src/app/(backend)/api/auth/[...all]/route.ts',
  // M09: exact thin mount into the enterprise-owned OAuth callback adapter
  'src/app/(backend)/oauth/connector/callback/route.ts',
  // M05: effective settings + updateSettings adapter
  'apps/server/src/routers/lambda/user.ts',
  // M05: agent / systemAgent / agentGroup runtime reads through resolver adapter
  'apps/server/src/services/agent/index.ts',
  'apps/server/src/services/systemAgent/index.ts',
  'apps/server/src/services/taskReview/index.ts',
  'apps/server/src/services/memory/userMemory/persona/service.ts',
  'apps/server/src/services/aiAgent/index.ts',
  'apps/server/src/services/connector/sync.ts',
  'apps/server/src/services/toolExecution/index.ts',
  'apps/server/src/modules/AgentRuntime/buildHost.ts',
  'apps/server/src/routers/tools/mcp.ts',
  'apps/server/src/routers/lambda/agentGroup.ts',
  // M05: memory runtime reads through the effective settings resolver
  'apps/server/src/routers/lambda/userMemories.ts',
  'apps/server/src/services/toolExecution/serverRuntimes/memory.ts',
  // M08: server execution seams consume the operation-pinned Skill Catalog.
  'apps/server/src/services/toolExecution/serverRuntimes/skills.ts',
  'apps/server/src/services/toolExecution/serverRuntimes/platformSkillWorkspace.ts',
  'apps/server/src/services/toolExecution/serverRuntimes/activator.ts',
  'apps/server/src/routers/tools/market.ts',
  // M05: user-facing source badge meta hook (thin SWR → enterprise service)
  'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.ts',
  'src/features/PlatformSettingSourceBadge/ManagedFormControl.tsx',
  'src/features/PlatformSettingSourceBadge/ManagedSettingField.tsx',
  'src/features/ChatInput/ControlBar/ApprovalMode.tsx',
  // M08: managed Skill settings mount the public catalog hook at read-only surfaces.
  'src/features/ChatInput/ActionBar/Tools/useControls.tsx',
  'src/features/ProfileEditor/AgentTool.tsx',
  'src/routes/(main)/settings/skill/features/PlatformSkillList.tsx',
  'src/routes/(main)/settings/skill/features/SkillDetail/PlatformSkillDetail.tsx',
  // M06: public managed-resource capability adapter; ordinary surfaces import this adapter only.
  'src/features/ManagedResources/useManagedResource.ts',
  // M06: stable server enforcement seams for the five legacy mutation routers.
  'apps/server/src/routers/lambda/agent.ts',
  'apps/server/src/routers/lambda/agentDocument.ts',
  'apps/server/src/routers/lambda/agentGroup.ts',
  'apps/server/src/routers/lambda/agentSkills.ts',
  'apps/server/src/routers/lambda/aiModel.ts',
  'apps/server/src/routers/lambda/aiProvider.ts',
  'apps/server/src/routers/lambda/composio.ts',
  'apps/server/src/routers/lambda/connector.ts',
  'apps/server/src/routers/lambda/home.ts',
  'apps/server/src/routers/lambda/oauthDeviceFlow.ts',
  // script entry only
  'package.json',
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
  // TODO(M15): tighten — global *.test.* / __tests__ exemption lets non-enterprise
  // test files import @/enterprise freely. Prefer allowlisting enterprise + mount
  // colocated tests only once M03+ suites stabilize.
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
