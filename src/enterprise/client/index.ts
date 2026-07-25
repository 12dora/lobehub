export { isPlatformAdminBootEnabled } from './boot/isPlatformAdminBootEnabled';
export { mapEnterpriseError } from './errors/mapEnterpriseError';
export * from './features/admin';
export {
  ADMIN_NAV_FLAT,
  ADMIN_NAV_ITEMS,
  type AdminNavItem,
  canAccessAdminPath,
  filterAdminNavByPermissions,
  findAdminNavItemByPath,
  getAdminBreadcrumbs,
  hasAllPermissions,
} from './nav/adminNavMeta';
export {
  type AdminAccessContextValue,
  default as AdminAccessProvider,
  type AdminAccessStatus,
  useAdminAccess,
  useOptionalAdminAccess,
} from './providers/AdminAccessProvider';
export {
  type EnterprisePlatformContextValue,
  default as EnterprisePlatformProvider,
  useEnterprisePlatform,
} from './providers/EnterprisePlatformProvider';
export {
  BUILT_IN_RUNTIME_BRANDING,
  resolveRuntimeBranding,
  type RuntimeBranding,
} from './providers/runtimeBranding';
export {
  RuntimeBrandingProvider,
  type RuntimeBrandingProviderProps,
  useBranding,
  useRuntimeBranding,
} from './providers/RuntimeBrandingProvider';
// Types only — the singleton + register() are intentionally NOT re-exported from
// the public barrel. Desktop routes are a module-eval snapshot of the registry;
// late register() never rebuilds the router. Extension modules stay internal
// until a createDesktopRoutes() rebuild mechanism exists (CS-05 option b).
export type { EnterpriseModuleRegistration, EnterpriseModuleRegistry } from './registry';
export {
  createAdminRouteTree,
  EnterpriseDesktopRoutesWithoutMainLayout,
  getEnterpriseDesktopRoutesWithoutMainLayout,
} from './routes';
export {
  type AdminAccessSnapshot,
  type FetchAdminAccess,
  fetchAdminAccess,
  getAdminAccessErrorCode,
  isAdminAccessErrorRetryable,
} from './services/adminAuth';
export { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from './services/platform';
