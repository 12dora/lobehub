import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { useLocation } from 'react-router';

import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';

import { parseAgentPathname } from '../../utils/agentPathname';

const BUILTIN_SLUG_SET = new Set<string>(Object.values(BUILTIN_AGENT_SLUGS));

/**
 * The agent id the current URL points at, resolved from the pathname.
 *
 * `useParams()` is deliberately NOT used here: the agent sidebar is rendered
 * through `NavPanel`, which sits next to the router `<Outlet />` in the main
 * layout — so the `/agent/:aid` match is not in its React tree and `params.aid`
 * would always be empty. Parsing the pathname works in both mount positions
 * (NavPanel fallback before the lazy agent layout lands, and the portal after).
 *
 * Builtin slug URLs (`/agent/inbox`) resolve through the same slug -> id map
 * `AgentIdSync` uses; while a slug is still unresolved this returns `undefined`
 * rather than the slug, so callers never key the store/fetch on a non-id.
 */
export const useRoutedAgentId = (): string | undefined => {
  const { pathname } = useLocation();
  const routedSegment = parseAgentPathname(pathname)?.agentId;
  const isBuiltinSlug = !!routedSegment && BUILTIN_SLUG_SET.has(routedSegment);

  const resolvedBuiltinId = useAgentStore(
    builtinAgentSelectors.getBuiltinAgentId(isBuiltinSlug ? routedSegment! : ''),
  );

  if (isBuiltinSlug) return resolvedBuiltinId;

  return routedSegment;
};
