import { AGENT_CHAT_TOPIC_URL } from '@lobechat/const';
import { type Bar, BarList } from '@lobehub/charts';
import { ActionIcon, Alert, Icon } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import { MaximizeIcon, MessageSquareIcon } from 'lucide-react';
import qs from 'query-string';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import ImperativeModal from '@/components/ImperativeModal';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useOptionalAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import {
  ADMIN_GLOBAL_STATS_SCOPE,
  statsFilterParams,
  useStatsDataSource,
  useStatsFilter,
  useStatsSwrKey,
} from '@/features/SettingsStats';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import Link from '@/libs/router/Link';
import { useClientDataSWR } from '@/libs/swr';
import { statsKeys } from '@/libs/swr/keys';
import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';
import { type TopicRankItem } from '@/types/topic';
import { readEnterpriseErrorBodies } from '@/utils/enterpriseErrorBody';

import StatsFormGroup from '../components/StatsFormGroup';

/** Audit → General settings, where the content access mode lives. */
const AUDIT_RETENTION_PATH = '/admin/audit/retention';

/** Read-only conversation evidence for one topic — the admin counterpart of the chat URL. */
const auditTopicPath = (userId: string, topicId: string) =>
  `/admin/audit/conversations/${userId}/topics/${topicId}`;

/**
 * The audit policy switched conversation content off (or this actor may not read it).
 * The server refuses the ranking outright, so there is nothing to show but the reason.
 */
const isContentAccessDenied = (error: unknown): boolean => {
  if (!error) return false;
  if ((error as { data?: { code?: string } }).data?.code === 'FORBIDDEN') return true;
  return readEnterpriseErrorBodies(error).some(
    (body) =>
      (body.details as { reason?: unknown } | undefined)?.reason ===
      'audit_content_access_disabled',
  );
};

/** How one ranked bar behaves when activated. No target means the row is informational. */
interface TopicBarTarget {
  /** Skip the workspace-slug prefix — admin routes live outside workspaces. */
  escape?: boolean;
  path?: string;
}

/** A ranked bar carrying its own activation target (BarList hands the row back verbatim). */
interface TopicBar extends Bar {
  escape?: boolean;
  link?: string;
}

export const TopicsRank = memo<{ mobile?: boolean }>(({ mobile }) => {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('auth');
  const navigate = useWorkspaceAwareNavigate();
  const inboxAgentId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const currentUserId = useUserStore(userProfileSelectors.userId);
  const { rankTopics, scopeKey } = useStatsDataSource();
  const adminAccess = useOptionalAdminAccess();
  const params = statsFilterParams(useStatsFilter());
  const swrKey = useStatsSwrKey(statsKeys.rankTopics());
  const { data, isLoading, error, mutate } = useClientDataSWR(swrKey, async () =>
    rankTopics(undefined, params),
  );

  const isAdminScope = scopeKey === ADMIN_GLOBAL_STATS_SCOPE;
  // Only the admin ranking can be refused by the audit policy; personal stats ranks the
  // signed-in user's own topics and keeps its ordinary error handling.
  const contentDenied = isAdminScope && isContentAccessDenied(error);
  const canOpenRetention = Boolean(
    adminAccess?.permissions.includes(PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE),
  );

  const showExtra = !contentDenied && Boolean(data && data?.length > 5);

  /**
   * Personal stats opens the topic in the signed-in user's own chat. Admin stats must not:
   * `/agent/:agentId/:topicId` hydrates whatever id the URL carries into *this* account's
   * chat store, so another user's topic would be grafted onto the admin's own agent (the
   * inbox fallback made that the default for legacy topics). Admins get read-only audit
   * evidence instead, and rows with no known owner stay informational.
   */
  const resolveTarget = (item: TopicRankItem): TopicBarTarget => {
    const ownTopic = !isAdminScope || (!!item.userId && item.userId === currentUserId);

    if (ownTopic) {
      const agentId = item.agentId ?? (isAdminScope ? undefined : inboxAgentId);
      if (isAdminScope && !agentId) return {};
      const path = agentId ? AGENT_CHAT_TOPIC_URL(agentId, item.id) : '/';
      return {
        path:
          mobile && agentId
            ? qs.stringifyUrl({ query: { showMobileWorkspace: true }, url: path })
            : path,
      };
    }

    if (!item.userId) return {};
    return { escape: true, path: auditTopicPath(item.userId, item.id) };
  };

  const mapData = (item: TopicRankItem): TopicBar => {
    const target = resolveTarget(item);
    const label: ReactNode = target.path ? (
      <Link href={target.path} style={{ color: 'inherit' }}>
        {item.title}
      </Link>
    ) : (
      item.title
    );

    return {
      escape: target.escape,
      icon: <Icon color={cssVar.colorTextDescription} icon={MessageSquareIcon} size={16} />,
      key: item.id,
      link: target.path,
      name: label,
      value: item.count,
    };
  };

  const activate = (item: Bar) => {
    const { escape, link } = item as TopicBar;
    if (!link) return;
    // Admin routes are not workspace-scoped; chat routes still get the active slug.
    if (escape) navigate(link, { escape: true });
    else navigate(link);
  };

  const barList = (height: number, items: TopicRankItem[] | undefined) => (
    <BarList
      data={items?.map((item) => mapData(item)) || []}
      height={height}
      leftLabel={t('stats.topicsRank.left')}
      loading={isLoading || !data}
      rightLabel={t('stats.topicsRank.right')}
      noDataText={{
        desc: t('stats.empty.desc'),
        title: t('stats.empty.title'),
      }}
      onValueChange={activate}
    />
  );

  return (
    <>
      <StatsFormGroup
        fontSize={16}
        title={t('stats.topicsRank.title')}
        extra={
          showExtra && (
            <ActionIcon icon={MaximizeIcon} size={'small'} onClick={() => setOpen(true)} />
          )
        }
      >
        {contentDenied ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Alert
              showIcon
              message={t('stats.topicsRank.contentAccessDisabled')}
              type={'info'}
              action={
                canOpenRetention ? (
                  <Button
                    size={'small'}
                    onClick={() => navigate(AUDIT_RETENTION_PATH, { escape: true })}
                  >
                    {t('stats.topicsRank.contentAccessDisabledAction')}
                  </Button>
                ) : undefined
              }
            />
            <BarList
              data={[]}
              height={160}
              leftLabel={t('stats.topicsRank.left')}
              rightLabel={t('stats.topicsRank.right')}
              noDataText={{
                desc: t('stats.empty.desc'),
                title: t('stats.empty.title'),
              }}
            />
          </div>
        ) : (
          <AsyncBoundary data={data} error={error} errorVariant={'block'} onRetry={() => mutate()}>
            {barList(220, data?.slice(0, 5))}
          </AsyncBoundary>
        )}
      </StatsFormGroup>
      {showExtra && (
        <ImperativeModal
          footer={null}
          loading={isLoading || !data}
          open={open}
          title={t('stats.topicsRank.title')}
          onCancel={() => setOpen(false)}
        >
          {barList(340, data)}
        </ImperativeModal>
      )}
    </>
  );
});

export default TopicsRank;
