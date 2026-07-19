import { AGENT_CHAT_URL } from '@lobechat/const';
import { memo } from 'react';
import { Link } from 'react-router';

import { DEFAULT_INBOX_AVATAR } from '@/const/meta';
import { useDefaultInboxDisplayName } from '@/hooks/useDefaultInboxDisplayName';
import { useNavigateToAgent } from '@/hooks/useNavigateToAgent';
import { useAgentStore } from '@/store/agent';
import { agentSelectors, builtinAgentSelectors } from '@/store/agent/selectors';
import { useServerConfigStore } from '@/store/serverConfig';
import { useSessionStore } from '@/store/session';
import { sessionSelectors } from '@/store/session/selectors';

import ListItem from '../ListItem';

const Inbox = memo(() => {
  const mobile = useServerConfigStore((s) => s.isMobile);
  const isInboxActive = useSessionStore(sessionSelectors.isInboxSession);
  const navigateToAgent = useNavigateToAgent();
  const inboxAgentId = useAgentStore(builtinAgentSelectors.inboxAgentId);
  const inboxMeta = useAgentStore(agentSelectors.getAgentMetaById(inboxAgentId));
  const inboxDisplayName = useDefaultInboxDisplayName(inboxMeta.title);

  return (
    <Link
      aria-label={inboxDisplayName}
      to={AGENT_CHAT_URL(inboxAgentId, mobile)}
      onClick={(e) => {
        e.preventDefault();
        navigateToAgent(inboxAgentId);
      }}
    >
      <ListItem
        active={isInboxActive}
        avatar={DEFAULT_INBOX_AVATAR}
        key={'inbox'}
        title={inboxDisplayName}
        styles={{
          container: {
            gap: 12,
          },
          content: {
            gap: 6,
            maskImage: `linear-gradient(90deg, #000 90%, transparent)`,
          },
        }}
      />
    </Link>
  );
});

export default Inbox;
