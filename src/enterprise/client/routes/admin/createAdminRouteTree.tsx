import { Text } from '@lobehub/ui';
import { lazy, type ReactNode, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { RouteObject } from 'react-router';

import AdminErrorBoundary from '@/enterprise/client/features/admin/gates/AdminErrorBoundary';
import AdminRootGate from '@/enterprise/client/features/admin/gates/AdminRootGate';
import NotFoundPage from '@/enterprise/client/features/admin/pages/NotFoundPage';
import OverviewPage from '@/enterprise/client/features/admin/pages/OverviewPage';
import PlaceholderPage from '@/enterprise/client/features/admin/pages/PlaceholderPage';
import { ADMIN_NAV_FLAT } from '@/enterprise/client/nav/adminNavMeta';

const UsersListPage = lazy(() => import('@/enterprise/client/features/admin/users/UsersListPage'));
const UserDetailPage = lazy(
  () => import('@/enterprise/client/features/admin/users/UserDetailPage'),
);
const AdminReauthCompletePage = lazy(
  () => import('@/enterprise/client/features/admin/reauth/AdminReauthCompletePage'),
);
const SettingsPolicyPage = lazy(
  () => import('@/enterprise/client/features/admin/settings/SettingsPolicyPage'),
);
const ManagedResourcesPolicyPage = lazy(
  () => import('@/enterprise/client/features/admin/managedResources/ManagedResourcesPolicyPage'),
);
const UnifiedManagementPage = lazy(
  () => import('@/enterprise/client/features/admin/unified/UnifiedManagementPage'),
);
const AiProviderSettingsPage = lazy(
  () => import('@/enterprise/client/features/admin/ai/providerSettings/ProviderSettingsPage'),
);
const AiServiceModelSettingsPage = lazy(
  () => import('@/enterprise/client/features/admin/ai/settingsForms/ServiceModelSettingsPage'),
);
const AiMemorySettingsPage = lazy(
  () => import('@/enterprise/client/features/admin/ai/settingsForms/MemorySettingsPage'),
);
const AiSkillSettingsPage = lazy(
  () => import('@/enterprise/client/features/admin/ai/skills/SkillSettingsPage'),
);
const AiConnectorSettingsPage = lazy(
  () => import('@/enterprise/client/features/admin/ai/connectors/ConnectorSettingsPage'),
);
const AiCatalogProviderListPage = lazy(
  () => import('@/enterprise/client/features/admin/ai/providers/ProviderListPage'),
);
const AiCatalogProviderDetailPage = lazy(
  () => import('@/enterprise/client/features/admin/ai/providers/ProviderDetailPage'),
);
const AiCatalogModelListPage = lazy(
  () => import('@/enterprise/client/features/admin/ai/models/ModelListPage'),
);
const SkillListPage = lazy(() => import('@/enterprise/client/features/admin/skills/SkillListPage'));
const SkillDetailPage = lazy(
  () => import('@/enterprise/client/features/admin/skills/SkillDetailPage'),
);
const ConnectorListPage = lazy(
  () => import('@/enterprise/client/features/admin/connectors/ConnectorListPage'),
);
const ConnectorDetailPage = lazy(
  () => import('@/enterprise/client/features/admin/connectors/ConnectorDetailPage'),
);
const AgentListPage = lazy(() => import('@/enterprise/client/features/admin/agents/AgentListPage'));
const AgentDetailPage = lazy(
  () => import('@/enterprise/client/features/admin/agents/AgentDetailPage'),
);
const BrandingPage = lazy(() => import('@/enterprise/client/features/admin/branding/BrandingPage'));
const IdentityProviderPage = lazy(
  () => import('@/enterprise/client/features/admin/identityProviders/IdentityProviderPage'),
);
const SystemPage = lazy(() => import('@/enterprise/client/features/admin/system'));
const GlobalStatsPage = lazy(
  () => import('@/enterprise/client/features/admin/stats/GlobalStatsPage'),
);

/** Honest localized loading surface for lazy admin pages (no blank frame). */
const AdminLazyFallback = () => {
  const { t } = useTranslation('admin');
  return (
    <div role="status" style={{ padding: 24 }}>
      <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
    </div>
  );
};

const withLazy = (node: ReactNode) => <Suspense fallback={<AdminLazyFallback />}>{node}</Suspense>;

/** Resolve the page element for a catalog item (M04 users are real; others stay placeholders). */
const resolveAdminLeafElement = (id: string): ReactNode => {
  switch (id) {
    case 'users': {
      return withLazy(<UsersListPage />);
    }
    case 'users-detail': {
      return withLazy(<UserDetailPage />);
    }
    case 'reauth-complete': {
      return withLazy(<AdminReauthCompletePage />);
    }
    case 'settings': {
      return withLazy(<SettingsPolicyPage />);
    }
    case 'managed-resources': {
      return withLazy(<ManagedResourcesPolicyPage />);
    }
    case 'unified-management': {
      return withLazy(<UnifiedManagementPage />);
    }
    case 'ai-providers':
    case 'ai-provider-detail': {
      return withLazy(<AiProviderSettingsPage />);
    }
    case 'ai-service-model': {
      return withLazy(<AiServiceModelSettingsPage />);
    }
    case 'ai-memory': {
      return withLazy(<AiMemorySettingsPage />);
    }
    case 'ai-skills':
    case 'ai-skill-detail': {
      return withLazy(<AiSkillSettingsPage />);
    }
    case 'ai-connectors':
    case 'ai-connector-detail': {
      return withLazy(<AiConnectorSettingsPage />);
    }
    case 'ai-catalog-providers': {
      return withLazy(<AiCatalogProviderListPage />);
    }
    case 'ai-catalog-provider-detail': {
      return withLazy(<AiCatalogProviderDetailPage />);
    }
    case 'ai-catalog-models': {
      return withLazy(<AiCatalogModelListPage />);
    }
    case 'skills': {
      return withLazy(<SkillListPage />);
    }
    case 'skills-detail': {
      return withLazy(<SkillDetailPage />);
    }
    case 'connectors': {
      return withLazy(<ConnectorListPage />);
    }
    case 'connectors-detail': {
      return withLazy(<ConnectorDetailPage />);
    }
    case 'agents': {
      return withLazy(<AgentListPage />);
    }
    case 'agents-detail': {
      return withLazy(<AgentDetailPage />);
    }
    case 'branding': {
      return withLazy(<BrandingPage />);
    }
    case 'identity-providers': {
      return withLazy(<IdentityProviderPage />);
    }
    case 'system': {
      return withLazy(<SystemPage />);
    }
    case 'stats': {
      return withLazy(<GlobalStatsPage />);
    }
    default: {
      return <PlaceholderPage />;
    }
  }
};

/**
 * Build the independent `/admin` route tree (no main-app layout nesting).
 * Paths come from the same nav metadata catalog used for menus and guards.
 */
export const createAdminRouteTree = (): RouteObject[] => {
  const reauthComplete = ADMIN_NAV_FLAT.find((item) => item.id === 'reauth-complete');
  if (!reauthComplete) throw new Error('ADMIN_REAUTH_COMPLETE_ROUTE_MISSING');
  const leafPaths = ADMIN_NAV_FLAT.filter(
    (item) => item.path !== '/admin' && item.id !== 'reauth-complete',
  ).map((item) => {
    // Convert absolute /admin/foo to relative foo under the /admin parent
    // Preserve :param segments for React Router
    const relative = item.path.replace(/^\/admin\/?/, '');
    return {
      element: resolveAdminLeafElement(item.id),
      handle: {
        admin: {
          id: item.id,
          placeholder: item.placeholder ?? false,
          requiredPermissions: item.requiredPermissions,
        },
      },
      path: relative,
    } satisfies RouteObject;
  });

  return [
    {
      element: (
        <AdminErrorBoundary>{resolveAdminLeafElement(reauthComplete.id)}</AdminErrorBoundary>
      ),
      handle: {
        admin: {
          id: reauthComplete.id,
          placeholder: false,
          requiredPermissions: reauthComplete.requiredPermissions,
        },
      },
      path: reauthComplete.path,
    },
    {
      children: [
        {
          element: <OverviewPage />,
          handle: {
            admin: {
              id: 'overview',
              placeholder: false,
              requiredPermissions: [],
            },
          },
          index: true,
        },
        ...leafPaths,
        {
          element: <NotFoundPage />,
          path: '*',
        },
      ],
      element: (
        <AdminErrorBoundary>
          <AdminRootGate />
        </AdminErrorBoundary>
      ),
      path: '/admin',
    },
  ];
};
