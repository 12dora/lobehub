export const normalizeTabUrl = (url: string): string => {
  const [rawPath = '', rawQuery = ''] = url.split('?');

  let pathname = rawPath || '/';
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.replace(/\/+$/, '') || '/';
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;

  const queryString = rawQuery.split('#')[0] ?? '';
  if (!queryString) return pathname;

  const params = new URLSearchParams(queryString);
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return pathname;

  const sorted = new URLSearchParams();
  for (const [key, value] of entries) sorted.append(key, value);

  return `${pathname}?${sorted.toString()}`;
};

export interface AgentTabContext {
  agentId: string;
  topicId: string | null;
  workspaceSlug?: string;
}

const WORKSPACE_AGENT_TOPIC_PATH = /^\/([^/]+)\/agent\/([^/]+)\/(tpc_[^/]+)(?:\/|$)/;
const WORKSPACE_AGENT_PATH = /^\/([^/]+)\/agent\/([^/]+)(?:\/|$)/;
const AGENT_TOPIC_PATH = /^\/agent\/([^/]+)\/(tpc_[^/]+)(?:\/|$)/;
const AGENT_PATH = /^\/agent\/([^/]+)(?:\/|$)/;

/** Personal home (`/`) and workspace home (`/:slug`), with or without a trailing slash. */
const HOME_PATH = /^\/$/;
const WORKSPACE_HOME_PATH = /^\/([^/]+)\/?$/;

export const parseAgentTabContext = (url: string): AgentTabContext | null => {
  const [rawPath = '', rawQuery = ''] = url.split('?');

  /**
   * Home-context conversations (`/?agent=…&topic=…`, `/:slug?agent=…&topic=…`).
   *
   * The home shell opens a recent conversation *in place*: the pathname stays
   * home and the conversation lives in the query string. Without this branch a
   * tab parked on such a URL is indistinguishable from the home landing page and
   * loses its running / unread indicators, even though it is showing the very
   * same conversation `/agent/:aid/:topicId` would.
   *
   * Group home URLs (`?group=`) deliberately fall through to `null`, matching
   * what canonical `/group/...` URLs already do here.
   */
  const homeQuery = new URLSearchParams(rawQuery.split('#')[0] ?? '');
  const homeAgentId = homeQuery.get('agent');
  if (homeAgentId) {
    const homeTopicId = homeQuery.get('topic');

    if (HOME_PATH.test(rawPath) || rawPath === '')
      return { agentId: homeAgentId, topicId: homeTopicId || null };

    const workspaceHomeMatch = rawPath.match(WORKSPACE_HOME_PATH);
    if (workspaceHomeMatch && workspaceHomeMatch[1] !== 'agent')
      return {
        agentId: homeAgentId,
        topicId: homeTopicId || null,
        workspaceSlug: workspaceHomeMatch[1],
      };
  }

  const workspaceTopicMatch = rawPath.match(WORKSPACE_AGENT_TOPIC_PATH);
  if (workspaceTopicMatch) {
    return {
      agentId: workspaceTopicMatch[2],
      topicId: workspaceTopicMatch[3],
      workspaceSlug: workspaceTopicMatch[1],
    };
  }

  const topicMatch = rawPath.match(AGENT_TOPIC_PATH);
  if (topicMatch) return { agentId: topicMatch[1], topicId: topicMatch[2] };

  const workspaceAgentMatch = rawPath.match(WORKSPACE_AGENT_PATH);
  if (workspaceAgentMatch) {
    const queryTopic = new URLSearchParams(rawQuery.split('#')[0] ?? '').get('topic');
    return {
      agentId: workspaceAgentMatch[2],
      topicId: queryTopic || null,
      workspaceSlug: workspaceAgentMatch[1],
    };
  }

  const agentMatch = rawPath.match(AGENT_PATH);
  if (!agentMatch) return null;

  const queryTopic = new URLSearchParams(rawQuery.split('#')[0] ?? '').get('topic');
  return { agentId: agentMatch[1], topicId: queryTopic || null };
};
