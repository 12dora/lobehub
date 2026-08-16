import { Text } from '@lobehub/ui';
import { lazy, type ReactNode, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import NotFoundPage from '@/enterprise/client/features/admin/pages/NotFoundPage';

/**
 * Single source of truth for admin leaf page components.
 * createAdminRouteTree and catalog tests both resolve pages from this map —
 * no parallel switch statements or silent placeholder defaults for known ids.
 */
const OverviewPage = lazy(() => import('@/enterprise/client/features/admin/pages/OverviewPage'));
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
const SecurityAuthPage = lazy(
  () => import('@/enterprise/client/features/admin/securityAuth/SecurityAuthPage'),
);
const SystemPage = lazy(() => import('@/enterprise/client/features/admin/system'));
const SystemGeneralPage = lazy(
  () => import('@/enterprise/client/features/admin/systemGeneral/SystemGeneralPage'),
);
const TaskTemplateListPage = lazy(
  () => import('@/enterprise/client/features/admin/taskTemplates/TaskTemplateListPage'),
);
const GlobalStatsPage = lazy(
  () => import('@/enterprise/client/features/admin/stats/GlobalStatsPage'),
);
const GroupIndexRedirect = lazy(
  () => import('@/enterprise/client/features/admin/gates/GroupIndexRedirect'),
);
const OperationLogsPage = lazy(
  () => import('@/enterprise/client/features/admin/audit/operationLogs/OperationLogsPage'),
);
const AuditLivePage = lazy(() => import('@/enterprise/client/features/admin/audit/live/LivePage'));
const ConversationsSearchPage = lazy(
  () => import('@/enterprise/client/features/admin/audit/conversations/ConversationsSearchPage'),
);
const ConversationUserPage = lazy(
  () => import('@/enterprise/client/features/admin/audit/conversations/ConversationUserPage'),
);
const ConversationTopicPage = lazy(
  () => import('@/enterprise/client/features/admin/audit/conversations/ConversationTopicPage'),
);
const ExportsPage = lazy(
  () => import('@/enterprise/client/features/admin/audit/exports/ExportsPage'),
);
const LegalHoldsPage = lazy(
  () => import('@/enterprise/client/features/admin/audit/holds/LegalHoldsPage'),
);
const ContentModerationPage = lazy(
  () => import('@/enterprise/client/features/admin/contentModeration/ContentModerationPage'),
);
const RetentionPage = lazy(
  () => import('@/enterprise/client/features/admin/audit/retention/RetentionPage'),
);

const AdminLazyFallback = () => {
  const { t } = useTranslation('admin');
  return (
    <div role="status" style={{ padding: 24 }}>
      <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
    </div>
  );
};

const withLazy = (node: ReactNode) => <Suspense fallback={<AdminLazyFallback />}>{node}</Suspense>;

/**
 * Implemented page registry: id → stable component identity token + element factory.
 * Tests assert intended component identity via `componentId`, not mere element truthiness.
 */
export const ADMIN_PAGE_BY_ID: Readonly<
  Record<string, { componentId: string; element: ReactNode }>
> = {
  'overview': { componentId: 'OverviewPage', element: withLazy(<OverviewPage />) },
  'users': { componentId: 'UsersListPage', element: withLazy(<UsersListPage />) },
  'users-detail': { componentId: 'UserDetailPage', element: withLazy(<UserDetailPage />) },
  'reauth-complete': {
    componentId: 'AdminReauthCompletePage',
    element: withLazy(<AdminReauthCompletePage />),
  },
  'settings': { componentId: 'SettingsPolicyPage', element: withLazy(<SettingsPolicyPage />) },
  'managed-resources': {
    componentId: 'ManagedResourcesPolicyPage',
    element: withLazy(<ManagedResourcesPolicyPage />),
  },
  'unified-management': {
    componentId: 'UnifiedManagementPage',
    element: withLazy(<UnifiedManagementPage />),
  },
  'ai-providers': {
    componentId: 'AiProviderSettingsPage',
    element: withLazy(<AiProviderSettingsPage />),
  },
  'ai-provider-detail': {
    componentId: 'AiProviderSettingsPage',
    element: withLazy(<AiProviderSettingsPage />),
  },
  'ai-service-model': {
    componentId: 'AiServiceModelSettingsPage',
    element: withLazy(<AiServiceModelSettingsPage />),
  },
  'ai-memory': {
    componentId: 'AiMemorySettingsPage',
    element: withLazy(<AiMemorySettingsPage />),
  },
  'ai-skills': {
    componentId: 'AiSkillSettingsPage',
    element: withLazy(<AiSkillSettingsPage />),
  },
  'ai-skill-detail': {
    componentId: 'AiSkillSettingsPage',
    element: withLazy(<AiSkillSettingsPage />),
  },
  'ai-connectors': {
    componentId: 'AiConnectorSettingsPage',
    element: withLazy(<AiConnectorSettingsPage />),
  },
  'ai-connector-detail': {
    componentId: 'AiConnectorSettingsPage',
    element: withLazy(<AiConnectorSettingsPage />),
  },
  'skills': { componentId: 'SkillListPage', element: withLazy(<SkillListPage />) },
  'skills-detail': { componentId: 'SkillDetailPage', element: withLazy(<SkillDetailPage />) },
  'connectors': {
    componentId: 'ConnectorListPage',
    element: withLazy(<ConnectorListPage />),
  },
  'connectors-detail': {
    componentId: 'ConnectorDetailPage',
    element: withLazy(<ConnectorDetailPage />),
  },
  'agents': { componentId: 'AgentListPage', element: withLazy(<AgentListPage />) },
  'agents-detail': { componentId: 'AgentDetailPage', element: withLazy(<AgentDetailPage />) },
  'branding': { componentId: 'BrandingPage', element: withLazy(<BrandingPage />) },
  'identity-providers': {
    componentId: 'SecurityAuthPage',
    element: withLazy(<SecurityAuthPage />),
  },
  'system': {
    componentId: 'SystemIndexRedirect',
    element: withLazy(<GroupIndexRedirect groupId="system" />),
  },
  'system-general': {
    componentId: 'SystemGeneralPage',
    element: withLazy(<SystemGeneralPage />),
  },
  'system-status': { componentId: 'SystemPage', element: withLazy(<SystemPage />) },
  'task-templates': {
    componentId: 'TaskTemplateListPage',
    element: withLazy(<TaskTemplateListPage />),
  },
  'stats': { componentId: 'GlobalStatsPage', element: withLazy(<GlobalStatsPage />) },
  'ai': { componentId: 'AiIndexRedirect', element: withLazy(<GroupIndexRedirect groupId="ai" />) },
  'audit': {
    componentId: 'AuditIndexRedirect',
    element: withLazy(<GroupIndexRedirect groupId="audit" />),
  },
  'audit-logs': {
    componentId: 'OperationLogsPage',
    element: withLazy(<OperationLogsPage />),
  },
  'audit-live': { componentId: 'AuditLivePage', element: withLazy(<AuditLivePage />) },
  'audit-conversations': {
    componentId: 'ConversationsSearchPage',
    element: withLazy(<ConversationsSearchPage />),
  },
  'audit-conversation-user': {
    componentId: 'ConversationUserPage',
    element: withLazy(<ConversationUserPage />),
  },
  'audit-conversation-topic': {
    componentId: 'ConversationTopicPage',
    element: withLazy(<ConversationTopicPage />),
  },
  'audit-exports': { componentId: 'ExportsPage', element: withLazy(<ExportsPage />) },
  'content-moderation': {
    componentId: 'ContentModerationPage',
    element: withLazy(<ContentModerationPage />),
  },
  'audit-legal-holds': {
    componentId: 'LegalHoldsPage',
    element: withLazy(<LegalHoldsPage />),
  },
  'audit-retention': {
    componentId: 'RetentionPage',
    element: withLazy(<RetentionPage />),
  },
};

export type AdminPageDescriptor = {
  componentId: string;
  element: ReactNode;
};

/** Resolve page for a catalog id. Every registered nav id has an entry; unknown ids fall back to a scoped 404. */
export const resolveAdminPage = (id: string): AdminPageDescriptor => {
  return ADMIN_PAGE_BY_ID[id] ?? { componentId: 'NotFoundPage', element: <NotFoundPage /> };
};

/** Component identity for tests — never rely on element truthiness alone. */
export const getAdminPageComponentId = (id: string): string => {
  return ADMIN_PAGE_BY_ID[id]?.componentId ?? 'NotFoundPage';
};
