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
  // M11: identity-provider admin test OAuth callback, and the DingTalk shim that rewrites
  // `authCode` → `code` before the Better Auth generic-OAuth callback
  'src/app/(backend)/oauth/identity-provider/dingtalk/[providerKey]/route.ts',
  'src/app/(backend)/oauth/identity-provider/test/callback/route.ts',
  // M11: test-attempt cleanup cron entry
  'src/app/(backend)/api/cron/identity-provider-test-attempt-cleanup/route.ts',
  // M12: branding asset id contract for public file route
  'src/app/(backend)/f/[id]/route.ts',
  // Network proxy: admin artifact upload (multipart; shares the enterprise webapi guard)
  'src/app/(backend)/webapi/admin/network-proxy/artifact/route.ts',
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
  'src/libs/better-auth/sso/platformDingTalkProvider.ts',
  'src/libs/better-auth/sso/platformIdentityProvider.ts',
  'src/libs/better-auth/sso/platformIdentityProviderObservation.ts',
  'src/libs/better-auth/sso/platformIdentityProviderProfile.ts',
  // M11 / M12: SPA + auth HTML shells resolve branding / identity bootstrap
  'src/app/spa/[variants]/[[...path]]/route.ts',
  'src/app/spa-auth/[locale]/[[...path]]/route.ts',
  'src/app/spa-auth/[locale]/[[...path]]/seoMeta.ts',
  'src/app/manifest.ts',
  'src/app/[variants]/metadata.ts',
  // slim (deployment slimming): tRPC root routers mount enterprise lazyRouter/moduleRouter one line per key
  'apps/server/src/routers/async/index.ts',
  'apps/server/src/routers/mobile/index.ts',
  'apps/server/src/routers/tools/index.ts',
  // slim: FEATURE_FLAGS derived from the module view (one-line wrapper)
  'apps/server/src/featureFlags/index.ts',
  // slim: search providers loaded on demand through the enterprise lazy impl map
  'apps/server/src/services/search/impls/index.ts',
  // slim: server tool-runtime registry gates a disabled module before importing its runtime
  'apps/server/src/services/toolExecution/serverRuntimes/index.ts',
  // slim: workflows routes answer PLATFORM_MODULE_DISABLED when the workflows module is off (one-line gate each)
  'src/app/(backend)/api/workflows/agent-eval-run/execute-test-case/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/finalize-run/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/on-thread-complete/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/on-trajectory-complete/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/paginate-test-cases/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/resume-agent-trajectory/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/resume-thread-trajectory/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/run-agent-trajectory/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/run-benchmark/route.ts',
  'src/app/(backend)/api/workflows/agent-eval-run/run-thread-trajectory/route.ts',
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
    file: 'src/routes/(main)/settings/about/features/About.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/settings/about/features/Version.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'Ordinary UI consumer of useBranding; not a whole-file mount',
  },
  {
    file: 'src/layout/AuthProvider/MarketAuth/MarketAuthConfirmModal.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Portal/Artifacts/Body/Renderer/SVG.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/PWAInstall/Install.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/User/UserAvatar.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/WorkspaceSetting/Storage/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/hooks/useScreenshot.ts',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/ChatPreview.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/settings/about/features/Analytics.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/settings/storage/features/Advanced.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/settings/stats/features/overview/Welcome.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/group/features/TelemetryNotification.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/agent/features/TelemetryNotification.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/community/(detail)/agent/features/Details/Overview/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/community/(detail)/group_agent/features/Details/Overview/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/onboarding/features/TelemetryStep.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/services/config.ts',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/agent/channel/detail/ComingSoon.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/agent/channel/MessengerPromo.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/agent/channel/platform/imessage/CredentialExtras.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/agent/channel/detail/Body.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/agent/channel/detail/Footer.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(desktop)/desktop-onboarding/features/DataModeStep.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(desktop)/desktop-onboarding/features/LoginStep.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/community/(list)/_layout/Footer.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/community/features/CreateButton/Inner.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/community/(detail)/model/features/Details/Overview/ProviderList/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/community/(detail)/skill/features/Sidebar/Platform.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/MCPPluginDetail/Score/GithubBadge/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/SkillStore/SkillDetail/Overview.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/ProtocolUrlHandler/InstallPlugin/CustomPluginInstallModal.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/routes/(main)/settings/advanced/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Electron/navigation/useNavigationHistory.ts',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Electron/titlebar/TabBar/hooks/useResolvedTabs.ts',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/LinkModal/Slack.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/LinkModal/Discord.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/IntegrationList.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/IntegrationDetail/Slack.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/IntegrationDetail/shared.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/Verify/index.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/Verify/Body/Slack.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/Verify/Body/Discord.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/Verify/Body/Telegram.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
  },
  {
    file: 'src/features/Messenger/Verify/Body/shared.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason:
      'Ordinary UI consumer of runtime branding name (brand-leak fix); not a whole-file mount',
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
    file: 'src/features/RecommendTaskTemplates/useDailyBriefRecommendationsUI.ts',
    importSpecifier: '@/enterprise/client/hooks/usePlatformTaskTemplates',
    owner: 'M06',
    reason:
      'Ordinary consumer of the platform task-template policy hook; fails open to the market recommendations',
  },
  {
    file: 'apps/server/src/services/toolExecution/builtin.ts',
    importSpecifier: '@/server/enterprise/services/connectorGovernance/resolve',
    owner: 'M09',
    reason: 'Builtin tool-execution mounts the connector-governance resolve gate',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.ts',
    importSpecifier: '@/server/enterprise/services/chatgptWeb/transport',
    owner: 'M13',
    reason:
      'Single runtime-construction seam injects the ChatGPT Web impersonated transport (chatgpt.com 403s any plain-Node TLS fingerprint); server-only, never bundled into model-runtime',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.ts',
    importSpecifier: '@/server/enterprise/services/moduleSettings',
    owner: 'G2',
    reason: 'Boot-module gate for network-proxy egress binding at runtime construction',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.ts',
    importSpecifier: '@/server/enterprise/services/networkProxy/engine/bindEgress',
    owner: 'G2',
    reason: 'Binds G4 egress ALS only when the networkProxy module is on',
  },
  {
    file: 'src/server/agent-hono/index.ts',
    importSpecifier: '@/server/enterprise/guards/webapiModuleGate',
    owner: 'G2',
    reason: 'Hot path-prefix gate for optional platform modules on /api/agent/*',
  },
  {
    file: 'src/server/agent-hono/handlers/gatewayStart.ts',
    importSpecifier: '@/server/enterprise/services/moduleSettings',
    owner: 'G2',
    reason: 'Cheap bots-off reply for startServer.js gateway poller',
  },
  {
    file: 'src/server/workflows-hono/index.ts',
    importSpecifier: '@/server/enterprise/guards/webapiModuleGate',
    owner: 'G2',
    reason: 'Hot path-prefix gate for agentSignal / memory / workflows mounts',
  },
  {
    file: 'src/app/(backend)/api/workflows/[[...route]]/route.ts',
    importSpecifier: '@/server/enterprise/services/moduleSettings',
    owner: 'G2',
    reason: 'Early-exit when the workflows module is disabled',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.ts',
    importSpecifier: '@/server/enterprise/services/browserProfile',
    owner: 'D1',
    reason:
      'Single runtime-construction seam resolves the installation-wide synthetic browser profile before constructing ChatGPT Web; server-only, never bundled into model-runtime',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.ts',
    importSpecifier: '@/server/enterprise/services/cursorAgent',
    owner: 'C1',
    reason:
      'Single runtime-construction seam injects the Cursor Agent CLI transport (pseudo-HTTP https://cursor.local); server-only, never bundled into model-runtime',
  },
  {
    file: 'apps/server/src/services/oauthDeviceFlow/providers/githubCopilot.ts',
    importSpecifier: '@/server/enterprise/services/chatgptWeb/oauthService',
    owner: 'M13',
    reason:
      'getOAuthService factory resolves the authorization-code paste flow service for ChatGPT Web',
  },
  {
    file: 'apps/server/src/services/messenger/MessengerRouter.ts',
    importSpecifier: '@/server/enterprise/services/branding/runtimeBranding',
    owner: 'M12',
    reason:
      'Bot reply copy interpolates the published brand name instead of the compile-time constant',
  },
  {
    file: 'apps/server/src/modules/S3/index.ts',
    importSpecifier: '@/server/enterprise/services/infraSettings/snapshot',
    owner: 'infra-settings',
    reason: 'FileS3.create / createFileS3 resolve the DB-effective object-storage bag at runtime',
  },
  {
    file: 'apps/server/src/services/file/impls/s3.ts',
    importSpecifier: '@/server/enterprise/services/infraSettings/snapshot',
    owner: 'infra-settings',
    reason: 'Public URL / preview-expiry building uses the effective object-storage snapshot',
  },
  {
    file: 'apps/server/src/services/generation/video.ts',
    importSpecifier: '@/server/enterprise/guards/ffmpegStatic',
    owner: 'slim',
    reason:
      'ffmpeg-static resolved lazily behind the imageGen module gate (one-line await import swap)',
  },
  {
    file: 'apps/server/src/modules/AgentRuntime/adapters/serverCallLlmContextBuilder.ts',
    importSpecifier: '@/server/enterprise/services/user/userInfoReadMemo',
    owner: 'slim',
    reason:
      'Per-user short-TTL memo replacing one SELECT per LLM step (one-line await import swap)',
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
    file: 'src/features/User/__tests__/UserAvatar.test.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'vi.mock target for runtime branding in the brand-leak regression test',
  },
  {
    file: 'src/routes/(main)/settings/stats/features/overview/Welcome.test.tsx',
    importSpecifier: '@/enterprise/client/providers/RuntimeBrandingProvider',
    owner: 'M12',
    reason: 'vi.mock target for runtime branding in the brand-leak regression test',
  },
  {
    file: 'apps/server/src/services/messenger/MessengerRouter.test.ts',
    importSpecifier: '@/server/enterprise/services/branding/runtimeBranding',
    owner: 'M12',
    reason: 'vi.mock target for runtime branding in the brand-leak regression test',
  },
  {
    file: 'src/features/RecommendTaskTemplates/useDailyBriefRecommendationsUI.test.ts',
    importSpecifier: '@/enterprise/client/hooks/usePlatformTaskTemplates',
    owner: 'M06',
    reason:
      'vi.mock target for the platform task-template policy hook the recommendation hook consults',
  },
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
    file: 'apps/server/src/modules/ModelRuntime/index.test.ts',
    importSpecifier: '@/server/enterprise/services/contentModeration/runtime',
    owner: 'content-moderation',
    reason:
      'Documents the exact-revision wrap: a cross-provider downgrade from a MODEL-EXACT pin inits the target via initModelRuntimeFromDB({ skipModeration: true })',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.test.ts',
    importSpecifier: '@/server/enterprise/services/contentModeration/runtime/defaults',
    owner: 'content-moderation',
    reason: 'Uses the default initRuntime wiring to assert skipModeration on the exact-pin path',
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
    file: 'apps/server/src/services/oauthDeviceFlow/__tests__/refresh.test.ts',
    importSpecifier: '@/server/enterprise/services/chatgptWeb/transport',
    owner: 'M13',
    reason:
      'ChatGPT Web renews a web-session credential through the impersonated transport (a real child process); the transport is the only seam that can be stubbed to cover the renewal-kind dispatch in refresh.ts',
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
    importSpecifier: '@/server/enterprise/bootstrap/startupBootstrap',
    owner: 'M11',
    reason: 'Mocks the platform RBAC / super-admin startup bootstrap seam',
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
    file: 'src/instrumentation.test.ts',
    importSpecifier: '@/server/enterprise/services/moduleSettings',
    owner: 'G2',
    reason: 'Mocks boot-module init / bots gate for instrumentation register()',
  },
  {
    file: 'src/instrumentation.test.ts',
    importSpecifier: '@/server/enterprise/bootstrap/workersBootstrap',
    owner: 'G2',
    reason: 'Mocks the enterprise worker registry so register() stays cheap',
  },
  {
    file: 'src/server/agent-hono/handlers/__tests__/gatewayStart.test.ts',
    importSpecifier: '@/server/enterprise/services/moduleSettings',
    owner: 'G2',
    reason: 'Mocks the bots module gate on the gateway start handler',
  },
  {
    file: 'src/server/agent-hono/__tests__/gatewayStart.app.test.ts',
    importSpecifier: '@/server/enterprise/services/moduleSettings',
    owner: 'G2',
    reason: 'Full Hono-app test of the bots-off gateway/start 200 reply',
  },
  {
    file: 'src/libs/better-auth/sso/platformDingTalkProvider.route.test.ts',
    importSpecifier: '@/enterprise/server/dingtalkLoginCallback',
    owner: 'M11',
    reason:
      'End-to-end DingTalk login regression drives the real callback shim before the Better Auth handler',
  },
  {
    file: 'src/libs/better-auth/sso/platformDingTalkProvider.route.test.ts',
    importSpecifier: '@/server/enterprise/featureFlags',
    owner: 'M11',
    reason: 'DingTalk end-to-end regression stubs the database-OIDC flag the shim reads',
  },
  {
    file: 'src/libs/better-auth/sso/platformDingTalkProvider.route.test.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/startupArtifact',
    owner: 'M11',
    reason: 'DingTalk end-to-end regression stubs the active-provider artifact the shim validates',
  },
  {
    file: 'src/libs/better-auth/sso/platformDingTalkProvider.route.test.ts',
    importSpecifier: '@/server/enterprise/security/outboundHttp',
    owner: 'M11',
    reason: 'DingTalk handler-level regression drives the pinned outbound HTTP client',
  },
  {
    file: 'src/libs/better-auth/sso/platformDingTalkProvider.route.test.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/kinds',
    owner: 'M11',
    reason: 'DingTalk handler-level regression builds the static per-kind discovery metadata',
  },
  {
    file: 'src/libs/better-auth/sso/platformDingTalkProvider.test.ts',
    importSpecifier: '@/server/enterprise/security/outboundHttp',
    owner: 'M11',
    reason: 'DingTalk login-method adapter test drives the pinned outbound HTTP client',
  },
  {
    file: 'src/libs/better-auth/sso/platformDingTalkProvider.test.ts',
    importSpecifier: '@/server/enterprise/services/identityProvider/kinds',
    owner: 'M11',
    reason: 'DingTalk login-method adapter test builds the static per-kind discovery metadata',
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
    file: 'apps/server/src/routers/lambda/__tests__/aiProvider.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog/enforcement',
    owner: 'M07',
    reason:
      'Mocks the published-平台托管 takeover predicate at the aiProvider router test (the runtime adapter imports ./enforcement directly, so mocking the barrel would not intercept)',
  },
  {
    file: 'src/features/ManagedResources/useManagedResource.test.ts',
    importSpecifier: '@/enterprise/client/providers/EnterprisePlatformProvider',
    owner: 'M06',
    reason:
      'Mocks the enterprise platform context at the public managed-resource adapter test (the adapter itself is an allowlisted mount point)',
  },
  {
    file: 'apps/server/src/services/memory/userMemory/__tests__/extract.runtime.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog/enforcement',
    owner: 'M07',
    reason:
      'Mocks the published-平台托管 takeover predicate at the memory runtime test (the catalog runtime bridge imports ./enforcement directly)',
  },
  {
    file: 'apps/server/src/modules/ModelRuntime/index.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog/enforcement',
    owner: 'M07',
    reason:
      'Mocks the published-平台托管 takeover predicate at the ModelRuntime BYOK-fallback test (the catalog runtime bridge imports ./enforcement directly)',
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
  {
    file: 'apps/server/src/routers/lambda/oauthDeviceFlow.test.ts',
    importSpecifier: '@/server/enterprise/services/chatgptWeb/oauthService',
    owner: 'M13',
    reason:
      'Builds a real ChatGPT Web OAuth service with mocked transports; the router branches on `instanceof`',
  },
  {
    file: 'apps/server/src/routers/lambda/oauthDeviceFlow.test.ts',
    importSpecifier: '@/server/enterprise/guards/managedResource',
    owner: 'M13',
    reason:
      'Pass-through mock of the managed-resource guard (it needs a live DB); the real guard keys stay asserted by managedResourceRealRouters.test.ts',
  },
  {
    file: 'src/app/(backend)/webapi/chat/[provider]/route.test.ts',
    importSpecifier: '@/server/enterprise/services/contentModeration/runtime',
    owner: 'content-moderation',
    reason:
      'Route-level proof that a moderation-aware runtime block/downgrade maps to HTTP 403 / x-lobe-moderation* headers',
  },
  {
    file: 'apps/server/src/services/file/impls/s3.test.ts',
    importSpecifier: '@/server/enterprise/services/infraSettings/snapshot',
    owner: 'infra-settings',
    reason: 'Mocks the infra snapshot so URL characterization stays on the fileEnv fixture',
  },
  {
    file: 'apps/server/src/modules/S3/createFileS3.memo.test.ts',
    importSpecifier: '@/server/enterprise/services/infraSettings/snapshot',
    owner: 'infra-settings',
    reason: 'Keys createFileS3 memo tests on a fake infra snapshot fingerprint',
  },
  {
    file: 'src/libs/better-auth/define-config.test.ts',
    importSpecifier: '@/server/enterprise/services/infraSettings/snapshot',
    owner: 'infra-settings',
    reason: 'Stubs the infra snapshot so Better Auth config tests do not open a DB on import',
  },
  {
    file: 'apps/server/src/globalConfig/getServerGlobalConfig.test.ts',
    importSpecifier: '@/server/enterprise/featureFlags',
    owner: 'slim',
    reason: 'vi.mock target for the module-derived feature flags in the global config tests',
  },
  {
    file: 'apps/server/src/globalConfig/getServerGlobalConfig.test.ts',
    importSpecifier: '@/server/enterprise/services/aiCatalog/runtimeBridge',
    owner: 'slim',
    reason: 'vi.mock target for the AI catalog bridge in the global config tests',
  },
  {
    file: 'apps/server/src/globalConfig/getServerGlobalConfig.test.ts',
    importSpecifier: '@/server/enterprise/services/infraSettings/snapshot',
    owner: 'slim',
    reason: 'vi.mock target for the infra settings snapshot in the global config tests',
  },
  {
    file: 'apps/server/src/globalConfig/getServerGlobalConfig.test.ts',
    importSpecifier: '@/server/enterprise/services/moduleSettings',
    owner: 'slim',
    reason: 'vi.mock target for the module settings snapshot in the global config tests',
  },
  {
    file: 'apps/server/src/routers/lambda/__tests__/user.test.ts',
    importSpecifier: '@/server/enterprise/services/user/getUserStateBundle',
    owner: 'slim',
    reason: 'vi.mock target for the one-roundtrip user state bundle',
  },
  {
    file: 'apps/server/src/services/toolExecution/serverRuntimes/__tests__/registry.test.ts',
    importSpecifier: '@/server/enterprise/guards/toolModuleGate',
    owner: 'slim',
    reason: 'vi.mock target proving the module gate runs before the runtime import',
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
