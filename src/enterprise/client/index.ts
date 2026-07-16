export { isKnownEnterpriseErrorMessage, mapEnterpriseError } from './errors/mapEnterpriseError';
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
  createEnterpriseModuleRegistry,
  type EnterpriseMenuItem,
  type EnterpriseModuleRegistration,
  type EnterpriseModuleRegistry,
  enterpriseModuleRegistry,
  type EnterpriseSystemCheck,
} from './registry';
export {
  createAdminRouteTree,
  EnterpriseDesktopRoutesWithoutMainLayout,
  getEnterpriseDesktopRoutesWithoutMainLayout,
  resolveEnterpriseDesktopRoutes,
} from './routes';
export {
  type AdminAccessSnapshot,
  type FetchAdminAccess,
  fetchAdminAccess,
  getAdminAccessErrorCode,
  isAdminAccessErrorRetryable,
} from './services/adminAuth';
export { fetchPlatformCapabilities, fetchPlatformPublicSnapshot } from './services/platform';
