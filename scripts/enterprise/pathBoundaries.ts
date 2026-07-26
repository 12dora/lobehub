/**
 * Pure path-boundary rules for AIHub enterprise code.
 * Used by CLI and unit tests.
 */

/** Repo-relative roots scanned by enterprise:check-paths (no node_modules/build artifacts). */
export const ENTERPRISE_PATH_BOUNDARY_SCAN_ROOTS = [
  'src',
  'apps/server/src',
  'apps/desktop/src',
  'apps/cli/src',
  'packages',
  'scripts/enterprise',
  'e2e',
] as const;

/** Upstream files allowed to import enterprise mounts freely (stable whole-file seams). */
export const ENTERPRISE_UPSTREAM_MOUNT_POINTS = [
  'src/business/client/BusinessDesktopRoutes.tsx',
  'src/business/client/BusinessGlobalProvider.tsx',
  // M03: mobile /admin deep-link unsupported surface
  'src/business/client/BusinessMobileRoutes.tsx',
  // M12 / auth shell: SPA auth session provider mirrors GlobalProvider mount
  'src/business/client/BusinessAuthProvider.tsx',
  'apps/server/src/routers/lambda/index.ts',
  // M00 mount #4: enterprise gate on GlobalServerConfig
  'apps/server/src/globalConfig/index.ts',
  // M11: public login provider list from startup artifact
  'apps/server/src/globalConfig/getServerAuthConfig.ts',
  'packages/types/src/serverConfig.ts',
  // M04: block Better Auth admin plugin mutations when platform admin is on
  'src/app/(backend)/api/auth/[...all]/route.ts',
  // M09: exact thin mount into the enterprise-owned OAuth callback adapter
  'src/app/(backend)/oauth/connector/callback/route.ts',
  // M11: identity-provider admin test OAuth callback
  'src/app/(backend)/oauth/identity-provider/test/callback/route.ts',
  // M11: test-attempt cleanup cron entry
  'src/app/(backend)/api/cron/identity-provider-test-attempt-cleanup/route.ts',
  // M12: branding asset id contract for public file route
  'src/app/(backend)/f/[id]/route.ts',
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
  // M10: web onboarding must not mutate platform-managed default inbox
  'apps/server/src/services/toolExecution/serverRuntimes/webOnboarding.ts',
  'apps/server/src/routers/tools/market.ts',
  // M10 / M12: onboarding + email consume platform default-inbox / branding
  'apps/server/src/services/onboarding/index.ts',
  'apps/server/src/services/email/index.ts',
  // M05: user-facing source badge meta hook (thin SWR → enterprise service)
  'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.ts',
  'src/features/PlatformSettingSourceBadge/ManagedFormControl.tsx',
  'src/features/PlatformSettingSourceBadge/ManagedSettingField.tsx',
  'src/features/ChatInput/ControlBar/ApprovalMode.tsx',
  // M08: managed Skill settings mount the public catalog hook at read-only surfaces.
  'src/features/ChatInput/ActionBar/Tools/useControls.tsx',
  // M08: agent tool editor managed-skill catalog / distribution seam (extracted from AgentTool).
  'src/features/ProfileEditor/useManagedAgentSkills.ts',
  // M09: single ordinary-user managed Connector authorization client seam.
  'src/features/PlatformConnectorAuthorization/enterpriseAdapter.ts',
  // M06: public managed-resource capability adapter; ordinary surfaces import this adapter only.
  'src/features/ManagedResources/useManagedResource.ts',
  // M06: stable server enforcement seams for the five legacy mutation routers.
  'apps/server/src/routers/lambda/agent.ts',
  'apps/server/src/routers/lambda/agentDocument.ts',
  'apps/server/src/routers/lambda/agentGroup.ts',
  'apps/server/src/routers/lambda/agentSkills.ts',
  'apps/server/src/routers/lambda/aiModel.ts',
  'apps/server/src/routers/lambda/aiProvider.ts',
  // M10: managed-agent active-user guard on exec surface
  'apps/server/src/routers/lambda/aiAgent.ts',
  'apps/server/src/routers/lambda/composio.ts',
  'apps/server/src/routers/lambda/connector.ts',
  'apps/server/src/routers/lambda/home.ts',
  'apps/server/src/routers/lambda/oauthDeviceFlow.ts',
  // M11: Better Auth + instrumentation identity / observability runtime seams
  'src/auth.ts',
  'src/instrumentation.ts',
  'src/libs/better-auth/sso/platformIdentityProvider.ts',
  'src/libs/better-auth/sso/platformIdentityProviderObservation.ts',
  // M11 / M12: SPA + auth HTML shells resolve branding / identity bootstrap
  'src/app/spa/[variants]/[[...path]]/route.ts',
  'src/app/spa-auth/[locale]/[[...path]]/route.ts',
  'src/app/spa-auth/[locale]/[[...path]]/seoMeta.ts',
  'src/app/manifest.ts',
  'src/app/[variants]/metadata.ts',
  // script entry only
  'package.json',
] as const;

/**
 * Exact (file, importSpecifier) allowlist for non-mount production / E2E support.
 *
 * Ordinary UI branding consumers and audited e2e seed helpers use this instead of
 * whole-file mount treatment so they cannot import unrelated enterprise modules.
 */
export interface EnterpriseImportAllowance {
  /** Repo-relative file path (posix). */
  file: string;
  /** Exact import specifier string as written in source. */
  importSpecifier: string;
  /** Owning milestone / surface for audit. */
  owner: string;
  /** Why this pair is a legitimate seam. */
  reason: string;
}

export const ENTERPRISE_PRODUCTION_IMPORT_ALLOWLIST = [
  {
    file: 'src/features/AdminToolScope/AdminBuiltinSkillDistribution.tsx',
    importSpecifier: '@/enterprise/client/services/adminAiInfraAdapter/errors',
    owner: 'M05',
    reason:
      'Reads the already-toasted marker so a failed builtin-distribution write does not surface two error toasts (XT-001/ASKC-03)',
  },
  {
    file: 'src/layout/GlobalProvider/FaviconProvider.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/components/Branding/ProductLogo/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/hooks/useDefaultInboxDisplayName.ts',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/AuthShell/AuthContainer.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/AuthShell/AuthFooterLinks.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/AuthShell/AuthAgreement.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/Auth/SignIn/SignInEmailStep.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/Auth/SignUp/BetterAuthSignUpForm.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/Auth/OAuthConsent/Consent/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/PluginDevModal/LocalForm.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/Recommendations/RecommendationCard.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/Setting/Footer.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/Electron/HeterogeneousAgent/StatusGuide/states/CliInstallState.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/Downloads/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/settings/memory/features/Memory.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/(create)/image/NotSupportClient.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/routes/(desktop)/desktop-onboarding/_layout/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/business/client/DefaultInboxBrandingSync.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/features/RouteMeta/RouteMetaBridge.tsx',
    importSpecifier: '@/enterprise/client',
    owner: 'M12',
    reason: 'Ordinary route meta uses useBranding from enterprise client barrel',
  },
  {
    file: 'e2e/src/identity-provider/seedIdentityProvider.ts',
    importSpecifier: '@/server/enterprise/security/secret',
    owner: 'M11',
    reason: 'E2E seed encrypts identity-provider client secret via PlatformSecretService',
  },
  {
    file: 'e2e/src/identity-provider/seedIdentityProvider.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/publicationService',
    owner: 'M11',
    reason: 'E2E seed builds PublishedIdentityProviderPayload via publication contract',
  },
  // Pre-existing enterprise consumers whose registration lagged (reconciled 2026-07-25).
  {
    file: 'src/features/Auth/SignIn/SignInEmailStep.tsx',
    importSpecifier: '@/enterprise/client/providers/EnterprisePlatformProvider',
    owner: 'M11',
    reason: 'Sign-in reads the enterprise platform snapshot for database-OIDC provider metadata',
  },
  {
    file: 'src/business/server/bot/featureAccess.ts',
    importSpecifier: '@/enterprise/server/bot/featureAccess',
    owner: 'M10',
    reason: 'Business bot feature-access stub delegates wholesale to the enterprise implementation',
  },
  {
    file: 'src/business/client/hooks/useHeteroAgentCloudConfig.ts',
    importSpecifier: '@/enterprise/client/hooks/useHeteroAgentCloudConfig',
    owner: 'M10',
    reason: 'Business heterogeneous-agent cloud-config stub delegates to the enterprise hook',
  },
  {
    file: 'src/business/client/DefaultInboxBrandingSync.tsx',
    importSpecifier: '@/enterprise/client/features/branding/DefaultInboxBrandingSync',
    owner: 'M12',
    reason: 'Business default-inbox branding sync mounts the enterprise branding component',
  },
  {
    file: 'src/features/SettingsForms/MemoryFormView.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Shared memory settings form consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/home/features/Recents/index.tsx',
    importSpecifier: '@/enterprise/client/hooks/useSidebarLayoutPolicy',
    owner: 'M06',
    reason: 'Ordinary UI consumer of the managed sidebar-layout policy hook',
  },
  {
    file: 'src/routes/(main)/home/_layout/Body/index.tsx',
    importSpecifier: '@/enterprise/client/hooks/useSidebarLayoutPolicy',
    owner: 'M06',
    reason: 'Ordinary UI consumer of the managed sidebar-layout policy hook',
  },
  {
    file: 'src/routes/(main)/home/_layout/Body/Agent/useDropdownMenu.tsx',
    importSpecifier: '@/enterprise/client/hooks/useSidebarLayoutPolicy',
    owner: 'M06',
    reason: 'Ordinary UI consumer of the managed sidebar-layout policy hook',
  },
  {
    file: 'src/routes/(main)/home/_layout/Body/Private/useDropdownMenu.tsx',
    importSpecifier: '@/enterprise/client/hooks/useSidebarLayoutPolicy',
    owner: 'M06',
    reason: 'Ordinary UI consumer of the managed sidebar-layout policy hook',
  },
  {
    file: 'apps/server/src/services/toolExecution/builtin.ts',
    importSpecifier: '@/server/enterprise/services/connectorGovernance/resolve',
    owner: 'M09',
    reason: 'Builtin tool-execution mounts the connector-governance resolve gate',
  },
] as const satisfies readonly EnterpriseImportAllowance[];

/**
 * Exact (file, importSpecifier) allowlist for non-enterprise tests.
 *
 * Covers static `from` / `import()` / `require` / side-effect `import` and
 * executable `vi.mock` / `vi.doMock` / `jest.mock` / `jest.doMock` references.
 * No wildcards — new tests must register each pair.
 */
export type EnterpriseTestImportAllowance = EnterpriseImportAllowance;

export const ENTERPRISE_TEST_IMPORT_ALLOWLIST = [
  {
    file: 'apps/server/src/services/memory/userMemory/persona/__tests__/service.test.ts',
    importSpecifier: '@/server/enterprise/testing/deletePlatformResourceRevisions',
    owner: 'M05',
    reason:
      'Shared teardown helper: prevent_platform_resource_revision_mutation rejects every DELETE; cleanup uses SET LOCAL session_replication_role=replica (not a GUC) inside a transaction',
  },
  {
    file: 'apps/server/src/services/memory/userMemory/persona/__tests__/service.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog/runtimeAdapter',
    owner: 'M07',
    reason:
      'Test isolation: clearAiCatalogRuntimeCache between cases so recycled provider pointers cannot serve a prior managed-AI projection',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.test.ts',
    importSpecifier: '@/server/enterprise/security/secret',
    owner: 'M07',
    reason: 'Mocks PlatformSecretService boundary at runtime/catalog test',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog',
    owner: 'M07',
    reason: 'Mocks AI catalog resolver at runtime path test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/agentSkills.resolvePlatformPinned.test.ts',
    importSpecifier: '@/server/enterprise/featureFlags',
    owner: 'M08',
    reason: 'Mocks enterprise feature flags at mount-adjacent test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/agentSkills.resolvePlatformPinned.test.ts',
    importSpecifier: '@/server/enterprise/services/managedResourceCapabilities',
    owner: 'M08',
    reason: 'Mocks managed resource capability snapshot at mount-adjacent test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/agentSkills.resolvePlatformPinned.test.ts',
    importSpecifier: '@/server/enterprise/services/skillCatalog',
    owner: 'M08',
    reason: 'Mocks skill catalog / public skills hook at mount-adjacent test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/aiProvider.test.ts',
    importSpecifier: '@/server/enterprise/security/secret',
    owner: 'M07',
    reason: 'Mocks PlatformSecretService boundary at runtime/catalog test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/aiProvider.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog',
    owner: 'M07',
    reason: 'Mocks AI catalog resolver at runtime path test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/connector.syncPluginTools.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/errors',
    owner: 'M09',
    reason: 'Mocks connector catalog seam at mount-adjacent test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/managedAgentActiveUser.guard.test.ts',
    importSpecifier: '@/server/enterprise/guards/activeUser',
    owner: 'M10',
    reason: 'Covers managed-agent guard at lambda mount test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/managedAgentActiveUser.guard.test.ts',
    importSpecifier: '@/server/enterprise/services/agentCatalog',
    owner: 'M10',
    reason: 'Mocks platform agent catalog at mount-adjacent test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/user.test.ts',
    importSpecifier: '@/server/enterprise/guards/managedPlatformAgent',
    owner: 'M10',
    reason: 'Covers managed-agent guard at lambda mount test',
  },
  {
    file: 'apps/server/src/routers/tools/market.test.ts',
    importSpecifier: '@/server/enterprise/featureFlags',
    owner: 'M08',
    reason: 'Mocks enterprise feature flags at mount-adjacent test',
  },
  {
    file: 'apps/server/src/routers/tools/market.test.ts',
    importSpecifier: '@/server/enterprise/services/managedResourceCapabilities',
    owner: 'M08',
    reason: 'Mocks managed resource capability snapshot at mount-adjacent test',
  },
  {
    file: 'apps/server/src/routers/tools/market.test.ts',
    importSpecifier: '@/server/enterprise/services/skillCatalog',
    owner: 'M08',
    reason: 'Mocks skill catalog / public skills hook at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/agent/index.test.ts',
    importSpecifier: '@/server/enterprise/services/agentCatalog/defaultInbox',
    owner: 'M10',
    reason: 'Mocks platform agent catalog at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/agent/index.test.ts',
    importSpecifier: '@/server/enterprise/services/branding/runtimeBranding',
    owner: 'M10',
    reason: 'Mocks/asserts runtime branding provider at consumer surface',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgent.headlessDefault.test.ts',
    importSpecifier: '@/server/enterprise/services/settings/runtimeSettingsAdapter',
    owner: 'M10',
    reason: 'Mocks effective settings adapter at runtime path test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgent.modelOverride.test.ts',
    importSpecifier: '@/server/enterprise/services/agentCatalog',
    owner: 'M10',
    reason: 'Mocks platform agent catalog at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgent.modelOverride.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/runtimeIntegration',
    owner: 'M10',
    reason: 'Mocks connector catalog seam at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgent.modelOverride.test.ts',
    importSpecifier: '@/server/enterprise/services/skillCatalog',
    owner: 'M10',
    reason: 'Mocks skill catalog / public skills hook at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgent.pluginTriState.test.ts',
    importSpecifier: '@/server/enterprise/services/managedResourceCapabilities',
    owner: 'M10',
    reason: 'Mocks managed resource capability snapshot at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgent.pluginTriState.test.ts',
    importSpecifier: '@/server/enterprise/services/skillCatalog',
    owner: 'M10',
    reason: 'Mocks skill catalog / public skills hook at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgentPlatform.test.ts',
    importSpecifier: '@/server/enterprise/services/agentCatalog',
    owner: 'M10',
    reason: 'Mocks platform agent catalog at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgentPlatform.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/runtimeIntegration',
    owner: 'M10',
    reason: 'Mocks connector catalog seam at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgentPlatform.test.ts',
    importSpecifier: '@/server/enterprise/services/skillCatalog',
    owner: 'M10',
    reason: 'Mocks skill catalog / public skills hook at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/platformServiceChain.integration.test.ts',
    importSpecifier: '@/server/enterprise/services/agentCatalog',
    owner: 'M10',
    reason: 'Mocks platform agent catalog at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/connector/exec.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/legacyMcpTransport',
    owner: 'M09',
    reason: 'Mocks connector catalog seam at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/connector/sync.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/runtimeIntegration',
    owner: 'M09',
    reason: 'Mocks connector catalog seam at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/email/index.test.ts',
    importSpecifier: '@/server/enterprise/services/branding',
    owner: 'M12',
    reason: 'Mocks branding service at shell/metadata test',
  },
  {
    file: 'apps/server/src/services/email/index.test.ts',
    importSpecifier: '@/server/enterprise/services/platformAudit',
    owner: 'M12',
    reason: 'Mocks platform audit service at email service test',
  },
  {
    file: 'apps/server/src/services/memory/userMemory/__tests__/extract.runtime.test.ts',
    importSpecifier: '@/server/enterprise/security/secret',
    owner: 'M07',
    reason: 'Mocks PlatformSecretService boundary at runtime/catalog test',
  },
  {
    file: 'apps/server/src/services/memory/userMemory/__tests__/extract.runtime.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog',
    owner: 'M07',
    reason: 'Mocks AI catalog resolver at runtime path test',
  },
  {
    file: 'apps/server/src/services/memory/userMemory/persona/__tests__/service.test.ts',
    importSpecifier: '@/server/enterprise/security/secret',
    owner: 'M07',
    reason: 'Mocks PlatformSecretService boundary at runtime/catalog test',
  },
  {
    file: 'apps/server/src/services/memory/userMemory/persona/__tests__/service.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog',
    owner: 'M07',
    reason: 'Mocks AI catalog resolver at runtime path test',
  },
  {
    file: 'apps/server/src/services/onboarding/index.test.ts',
    importSpecifier: '@/server/enterprise/services/agentCatalog/defaultInbox',
    owner: 'M10',
    reason: 'Mocks platform agent catalog at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/toolExecution/__tests__/index.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/legacyMcpTransport',
    owner: 'M08',
    reason: 'Mocks connector catalog seam at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/toolExecution/serverRuntimes/__tests__/activator.test.ts',
    importSpecifier: '@/server/enterprise/services/skillCatalog',
    owner: 'M08',
    reason: 'Mocks skill catalog / public skills hook at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/toolExecution/serverRuntimes/__tests__/platformSkillWorkspace.test.ts',
    importSpecifier: '@/server/enterprise/services/skillCatalog',
    owner: 'M08',
    reason: 'Mocks skill catalog / public skills hook at mount-adjacent test',
  },
  {
    file: 'apps/server/src/services/toolExecution/serverRuntimes/__tests__/skills.test.ts',
    importSpecifier: '@/server/enterprise/services/skillCatalog',
    owner: 'M08',
    reason: 'Mocks skill catalog / public skills hook at mount-adjacent test',
  },
  {
    file: 'src/app/(backend)/api/cron/identity-provider-test-attempt-cleanup/route.test.ts',
    importSpecifier: '@/server/enterprise/jobs/identityProviderTestAttemptCleanup',
    owner: 'M11',
    reason: 'Identity provider test-attempt cleanup cron coverage',
  },
  {
    file: 'src/app/(backend)/api/cron/identity-provider-test-attempt-cleanup/route.test.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/testAttemptStore',
    owner: 'M11',
    reason: 'Identity provider test-attempt cleanup cron coverage',
  },
  {
    file: 'src/app/(backend)/oauth/connector/callback/route.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/oauthRuntime',
    owner: 'M09',
    reason: 'Mocks connector catalog seam at mount-adjacent test',
  },
  {
    file: 'src/app/(backend)/oauth/connector/callback/route.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/userOAuthService',
    owner: 'M09',
    reason: 'Mocks connector catalog seam at mount-adjacent test',
  },
  {
    file: 'src/app/[variants]/metadata.test.ts',
    importSpecifier: '@/server/enterprise/services/branding',
    owner: 'M12',
    reason: 'Mocks branding service at shell/metadata test',
  },
  {
    file: 'src/app/manifest.test.ts',
    importSpecifier: '@/server/enterprise/services/branding',
    owner: 'M12',
    reason: 'Mocks branding service at shell/metadata test',
  },
  {
    file: 'src/app/spa-auth/[locale]/[[...path]]/route.test.ts',
    importSpecifier: '@/server/enterprise/services/branding',
    owner: 'M11',
    reason: 'Mocks branding service at shell/metadata test',
  },
  {
    file: 'src/app/spa-auth/[locale]/[[...path]]/route.test.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/bootstrap',
    owner: 'M11',
    reason: 'Mocks identity/observability bootstrap seam for instrumentation/auth tests',
  },
  {
    file: 'src/app/spa-auth/[locale]/[[...path]]/seoMeta.test.ts',
    importSpecifier: '@/enterprise/client/providers/runtimeBranding',
    owner: 'M11',
    reason: 'Mocks/asserts runtime branding provider at consumer surface',
  },
  {
    file: 'src/app/spa/[variants]/[[...path]]/route.test.ts',
    importSpecifier: '@/server/enterprise/services/branding',
    owner: 'M12',
    reason: 'Mocks branding service at shell/metadata test',
  },
  {
    file: 'src/auth.startupArtifact.test.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/startupArtifact',
    owner: 'M11',
    reason: 'Mocks identity/observability bootstrap seam for instrumentation/auth tests',
  },
  {
    file: 'src/features/AuthShell/resolveAuthFooterLinks.test.ts',
    importSpecifier: '@/enterprise/client/providers/runtimeBranding',
    owner: 'M12',
    reason: 'Mocks/asserts runtime branding provider at consumer surface',
  },
  {
    file: 'src/features/CommandMenu/AskAIMenu.test.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Mocks/asserts runtime branding provider at consumer surface',
  },
  {
    file: 'src/features/ChatInput/ActionBar/Tools/useControls.test.tsx',
    importSpecifier: '@/enterprise/client/features/skills',
    owner: 'M08',
    reason: 'Mocks the managed skill catalog seam while testing the ordinary-user retry menu item',
  },
  {
    file: 'src/features/ChatInput/ActionBar/Tools/useControls.test.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Mocks runtime branding required by the Chat tools menu hook under test',
  },
  {
    file: 'src/features/PlatformSettingSourceBadge/controlWiring.test.ts',
    importSpecifier: '@/server/enterprise/services/settings/registry',
    owner: 'M05',
    reason: 'Settings badge / control wiring test support',
  },
  {
    file: 'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
    importSpecifier: '@/enterprise/client/providers/EnterprisePlatformProvider',
    owner: 'M05',
    reason: 'Settings badge / control wiring test support',
  },
  {
    file: 'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
    importSpecifier: '@/enterprise/client/services/userSettings',
    owner: 'M05',
    reason: 'Settings badge / control wiring test support',
  },
  {
    file: 'src/features/PlatformSettingSourceBadge/usePlatformSettingMeta.test.ts',
    importSpecifier: '@/server/enterprise/contracts/userSettings',
    owner: 'M05',
    reason: 'Settings badge / control wiring test support',
  },
  {
    file: 'src/instrumentation.test.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/bootstrap',
    owner: 'M11',
    reason: 'Mocks identity/observability bootstrap seam for instrumentation/auth tests',
  },
  {
    file: 'src/instrumentation.test.ts',
    importSpecifier: '@/server/enterprise/services/platformInstance/heartbeatRuntime',
    owner: 'M11',
    reason: 'Mocks identity/observability bootstrap seam for instrumentation/auth tests',
  },
  {
    file: 'src/instrumentation.test.ts',
    importSpecifier: '@/server/enterprise/services/platformObservability/operationalMetricsRuntime',
    owner: 'M11',
    reason: 'Mocks identity/observability bootstrap seam for instrumentation/auth tests',
  },
  {
    file: 'src/libs/better-auth/sso/platformIdentityProvider.secureProfile.test.ts',
    importSpecifier: '@/server/enterprise/observability',
    owner: 'M11',
    reason: 'OIDC secure-profile observability / outbound HTTP test support',
  },
  {
    file: 'src/libs/better-auth/sso/platformIdentityProvider.secureProfile.test.ts',
    importSpecifier: '@/server/enterprise/security/outboundHttp',
    owner: 'M11',
    reason: 'OIDC secure-profile observability / outbound HTTP test support',
  },
  {
    file: 'src/routes/(main)/home/_layout/Footer/index.test.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Mocks/asserts runtime branding provider at consumer surface',
  },
  {
    file: 'src/routes/(main)/home/features/InputArea/MessengerBanner.test.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Mocks/asserts runtime branding provider at consumer surface',
  },
  {
    file: 'src/business/client/BusinessDesktopRoutes.registry.test.ts',
    importSpecifier: '@/enterprise/client/boot/isPlatformAdminBootEnabled',
    owner: 'M05',
    reason:
      'Mocks platform-admin boot flag so CS-05 late-register test can load desktopRoutes without real boot wiring',
  },
  {
    file: 'src/business/client/BusinessDesktopRoutes.registry.test.ts',
    importSpecifier: '@/enterprise/client/registry',
    owner: 'M05',
    reason:
      'Imports internal enterpriseModuleRegistry to prove late register never reaches frozen desktopRoutes',
  },
  {
    file: 'src/business/client/BusinessDesktopRoutes.registry.test.ts',
    importSpecifier: '@/enterprise/client/routes/admin/createAdminRouteTree',
    owner: 'M05',
    reason:
      'Stubs admin route-tree factory so resetModules does not load the full admin shell graph',
  },
  {
    file: 'src/features/ProfileEditor/useManagedAgentSkills.test.ts',
    importSpecifier: '@/enterprise/client/features/skills',
    owner: 'M08',
    reason: 'Asserts managed skill runtime source selection used by the agent tool seam',
  },
  {
    file: 'src/features/SettingsForms/formValueSync.test.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Mocks runtime branding at the shared memory settings form test',
  },
  // Pre-existing enterprise test consumers whose registration lagged (reconciled 2026-07-25).
  {
    file: 'src/libs/better-auth/sso/platformIdentityProvider.test.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/groupRoleMappingRuntime',
    owner: 'M11',
    reason: 'Covers group→role mapping runtime at the SSO identity-provider test',
  },
  {
    file: 'src/routes/(main)/agent/features/Conversation/HeterogeneousChatInput/index.test.tsx',
    importSpecifier: '@/enterprise/client/hooks/useHeteroAgentCloudConfig',
    owner: 'M10',
    reason: 'Mocks the heterogeneous-agent cloud-config hook at the chat-input test',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/aiProvider.test.ts',
    importSpecifier: '@/server/enterprise/services/platformInstance/catalogAuthority',
    owner: 'M08',
    reason: 'Mocks platform catalog-authority token at the aiProvider router test',
  },
  {
    file: 'apps/server/src/services/aiAgent/__tests__/execAgent.connectorGovernance.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorGovernance/resolve',
    owner: 'M09',
    reason: 'Covers connector-governance resolve gate at the execAgent test',
  },
  {
    file: 'apps/server/src/services/toolExecution/__tests__/governanceGate.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorCatalog/legacyMcpTransport',
    owner: 'M09',
    reason: 'Mocks connector catalog seam at the governance-gate test',
  },
  {
    file: 'apps/server/src/services/toolExecution/__tests__/governanceGate.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorGovernance/resolve',
    owner: 'M09',
    reason: 'Covers connector-governance resolve gate at the governance-gate test',
  },
  {
    file: 'apps/server/src/services/toolExecution/__tests__/builtin.governance.test.ts',
    importSpecifier: '@/server/enterprise/services/connectorGovernance/resolve',
    owner: 'M09',
    reason: 'Covers connector-governance resolve gate at the builtin-governance test',
  },
] as const satisfies readonly EnterpriseTestImportAllowance[];

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

/**
 * File-level production exemption: enterprise-owned trees and audited mount points.
 * Ordinary consumers and tests use exact (file, specifier) allowlists instead.
 */
export const isAllowedEnterpriseImporter = (filePath: string): boolean =>
  isEnterpriseOwnedPath(filePath) || isAllowedUpstreamMountPoint(filePath);

const matchesAllowance = (
  allowlist: readonly EnterpriseImportAllowance[],
  filePath: string,
  importSpecifier: string,
): boolean => {
  const path = normalizeRepoPath(filePath);
  return allowlist.some(
    (entry) => entry.file === path && entry.importSpecifier === importSpecifier,
  );
};

/** Exact (file, specifier) match against the audited production / E2E allowlist. */
export const isAllowedEnterpriseProductionImport = (
  filePath: string,
  importSpecifier: string,
): boolean => matchesAllowance(ENTERPRISE_PRODUCTION_IMPORT_ALLOWLIST, filePath, importSpecifier);

/** Exact (file, specifier) match against the audited test-support allowlist. */
export const isAllowedEnterpriseTestImport = (filePath: string, importSpecifier: string): boolean =>
  matchesAllowance(ENTERPRISE_TEST_IMPORT_ALLOWLIST, filePath, importSpecifier);

/**
 * Extract static module references that can bind enterprise code.
 *
 * Supported forms:
 * - `from '…'` / `from "…"`
 * - dynamic `import('…')` / `import("…")`
 * - `require('…')` / `require("…")`
 * - side-effect `import '…'` / `import "…"`
 * - executable mocks: `vi.mock` / `vi.doMock` / `jest.mock` / `jest.doMock` with static string first arg
 */
const IMPORT_RE =
  /from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|(?:vi|jest)\.(?:do)?[Mm]ock\(\s*['"]([^'"]+)['"]/g;

export const extractImportSpecifiers = (source: string): string[] => {
  const specs: string[] = [];
  const seen = new Set<string>();
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    if (!spec || seen.has(spec)) continue;
    seen.add(spec);
    specs.push(spec);
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
    // Full-file production exemptions (owned trees + mount points).
    if (isAllowedEnterpriseImporter(file.path)) continue;

    for (const spec of extractImportSpecifiers(file.source)) {
      if (!isEnterpriseImport(spec)) continue;
      if (isAllowedEnterpriseProductionImport(file.path, spec)) continue;
      if (isAllowedEnterpriseTestImport(file.path, spec)) continue;
      violations.push({
        file: normalizeRepoPath(file.path),
        importSpecifier: spec,
        reason:
          'Only enterprise-owned paths, allowlisted upstream mount points, or exact ENTERPRISE_PRODUCTION_IMPORT_ALLOWLIST / ENTERPRISE_TEST_IMPORT_ALLOWLIST (file+specifier) pairs may import enterprise modules',
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
