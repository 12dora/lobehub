import { DEFAULT_AVATAR } from '@lobechat/const';
import { ActionIcon, Avatar, Block, Flexbox, Icon, Text } from '@lobehub/ui';
import { Divider } from 'antd';
import { cssVar } from 'antd-style';
import { Check, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { taskDetailPath } from '@/features/AgentTasks/shared/taskDetailPath';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useDefaultInboxAvatar } from '@/hooks/useDefaultInboxAvatar';
import { useDefaultInboxDisplayName } from '@/hooks/useDefaultInboxDisplayName';
import Time from '@/routes/(main)/home/features/components/Time';
import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';

import BriefCardActions from './BriefCardActions';
import BriefCardArtifacts from './BriefCardArtifacts';
import BriefCardSummary from './BriefCardSummary';
import BriefIcon from './BriefIcon';
import { styles } from './style';
import { type AgentAvatarInfo, type BriefItem } from './types';

interface ProducingAgentAvatarProps {
  agent: AgentAvatarInfo;
}

const ProducingAgentAvatar = memo<ProducingAgentAvatarProps>(({ agent }) => {
  const { t } = useTranslation('common');
  // Briefs carry the database agent id, not the `inbox` builtin key.
  const inboxAgentId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const isInbox = !!inboxAgentId && agent.id === inboxAgentId;
  const inboxAvatar = useDefaultInboxAvatar(agent.avatar);
  const inboxTitle = useDefaultInboxDisplayName(agent.title);
  return (
    <Avatar
      avatar={isInbox ? inboxAvatar : agent.avatar || DEFAULT_AVATAR}
      background={agent.backgroundColor || cssVar.colorBgContainer}
      shape={'circle'}
      size={28}
      title={isInbox ? inboxTitle : agent.title || t('defaultSession')}
    />
  );
});

interface BriefCardProps {
  brief: BriefItem;
  /** When false, disables the header click-to-navigate behavior. */
  enableNavigation?: boolean;
  /** Hook invoked after a feedback comment is posted. */
  onAfterAddComment?: () => void | Promise<void>;
  /** Hook invoked after the brief is resolved. */
  onAfterResolve?: () => void | Promise<void>;
}

const BriefCard = memo<BriefCardProps>(
  ({ brief, enableNavigation = true, onAfterResolve, onAfterAddComment }) => {
    const navigate = useWorkspaceAwareNavigate();
    const { t } = useTranslation('home');
    const isResolved = Boolean(brief.resolvedAction);
    const [expanded, setExpanded] = useState(false);
    const showFull = !isResolved || expanded;

    const canNavigate = enableNavigation && Boolean(brief.taskId);
    const handleNavigate = () => {
      if (!brief.taskId) return;
      navigate(taskDetailPath(brief.taskId, brief.agentId ?? undefined));
    };

    return (
      <Block
        className={styles.card}
        gap={12}
        padding={12}
        style={{ borderRadius: cssVar.borderRadiusLG }}
        variant={'outlined'}
      >
        <Flexbox
          horizontal
          align={'center'}
          className={canNavigate ? styles.clickableHeader : undefined}
          gap={16}
          justify={'space-between'}
          onClick={canNavigate ? handleNavigate : undefined}
        >
          <Flexbox horizontal align={'center'} flex={1} gap={8} style={{ overflow: 'hidden' }}>
            <BriefIcon muted={isResolved} type={brief.type} />
            <Text ellipsis fontSize={16} weight={500}>
              {brief.title}
            </Text>
            <Time date={brief.createdAt} />
          </Flexbox>
          <Flexbox horizontal align={'center'} gap={8}>
            {isResolved && !expanded && (
              <Flexbox horizontal align={'center'} gap={4}>
                <Icon color={cssVar.colorTextQuaternary} icon={Check} size={14} />
                <Text className={styles.resolvedTag}>{t('brief.resolved')}</Text>
              </Flexbox>
            )}
            {brief.agent && <ProducingAgentAvatar agent={brief.agent} />}
            {isResolved && (
              <ActionIcon
                icon={expanded ? ChevronUpIcon : ChevronDownIcon}
                size={'small'}
                title={expanded ? t('brief.collapse') : t('brief.expandAll')}
                onClick={(event) => {
                  event.stopPropagation();
                  setExpanded((v) => !v);
                }}
              />
            )}
          </Flexbox>
        </Flexbox>
        {showFull && (
          <>
            <Divider dashed style={{ marginBlock: 0 }} />
            <BriefCardSummary summary={brief.summary} />
            <BriefCardArtifacts artifacts={brief.artifacts} />
            <BriefCardActions
              actions={brief.actions}
              briefId={brief.id}
              briefType={brief.type}
              resolvedAction={brief.resolvedAction}
              taskId={brief.taskId}
              taskStatus={brief.taskStatus}
              topicId={brief.topicId}
              onAfterAddComment={onAfterAddComment}
              onAfterResolve={onAfterResolve}
            />
          </>
        )}
      </Block>
    );
  },
);

export default BriefCard;
