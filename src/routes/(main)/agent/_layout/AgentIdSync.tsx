import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { usePrevious } from 'ahooks';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';

import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useAgentStore } from '@/store/agent';
import { builtinAgentSelectors } from '@/store/agent/selectors';
import { useChatStore } from '@/store/chat';

const BUILTIN_SLUG_SET = new Set<string>(Object.values(BUILTIN_AGENT_SLUGS));

const AgentIdSync = () => {
  const params = useParams<{ aid?: string; topicId?: string }>();
  const [searchParams] = useSearchParams();
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const navigate = useWorkspaceAwareNavigate();
  const location = useLocation();

  // Resolve builtin agent slug to real agent ID
  const isBuiltinSlug = !!params.aid && BUILTIN_SLUG_SET.has(params.aid);
  const resolvedId = useAgentStore(
    builtinAgentSelectors.getBuiltinAgentId(isBuiltinSlug ? params.aid! : ''),
  );

  // Redirect slug URL to real agent ID URL, preserving child path and query string
  useEffect(() => {
    if (isBuiltinSlug && resolvedId) {
      const suffix = location.pathname.replace(`/agent/${params.aid}`, '');
      const qs = searchParams.toString();
      navigate(`/agent/${resolvedId}${suffix}${qs ? `?${qs}` : ''}`, { replace: true });
    }
  }, [isBuiltinSlug, resolvedId, navigate, searchParams, location.pathname, params.aid]);

  // Use resolved ID when available, fall back to URL param (e.g. anonymous mode)
  const activeId = useMemo(
    () => (isBuiltinSlug ? resolvedId || params.aid : params.aid),
    [isBuiltinSlug, resolvedId, params.aid],
  );

  const prevAgentId = usePrevious(activeId);

  // Sync activeAgentId before paint (layout effect, not passive effect) so a
  // tab/route switch back to an agent with cached `agentMap` data renders the
  // real UI on the first frame instead of flashing a skeleton.
  useLayoutEffect(() => {
    if (!activeId) return;

    if (useAgentStore.getState().activeAgentId !== activeId)
      useAgentStore.setState({ activeAgentId: activeId }, false, 'AgentIdSync/syncAgentId');

    if (useChatStore.getState().activeAgentId !== activeId)
      useChatStore.setState({ activeAgentId: activeId }, false, 'AgentIdSync/syncAgentId');
  }, [activeId]);

  // Defense in depth: while this route is mounted it owns `activeAgentId`, but
  // another tree can still write to the store *after* the sync above ran — the
  // home layout stays mounted under React 19 `<Activity>` and its teardown
  // (which clears the inbox id) fires ~180ms after the navigation commit, long
  // after our layout effect. Re-apply the routed id whenever the store drifts,
  // so nothing downstream is left reading `undefined` forever.
  //
  // Declared BEFORE the unmount-clear effect below on purpose: React runs
  // layout cleanups in declaration order, so this unsubscribes first and cannot
  // resurrect the id that cleanup is about to clear.
  //
  // Only armed once the routed id is a real agent id — while a builtin slug
  // (`/agent/inbox`) is still unresolved we must not pin the slug into the store.
  const isResolvedRouteId = !isBuiltinSlug || !!resolvedId;

  useLayoutEffect(() => {
    if (!activeId || !isResolvedRouteId) return;

    return useAgentStore.subscribe((state, previous) => {
      if (state.activeAgentId === previous.activeAgentId) return;
      if (state.activeAgentId === activeId) return;

      useAgentStore.setState({ activeAgentId: activeId }, false, 'AgentIdSync/restoreAgentId');
    });
  }, [activeId, isResolvedRouteId]);

  // Reset activeTopicId when switching to a different agent
  // This prevents messages from being saved to the wrong topic bucket
  useEffect(() => {
    // Only reset topic when switching between agents (not on initial mount)
    if (prevAgentId !== undefined && prevAgentId !== activeId) {
      useChatStore.getState().clearPortalStack();

      // Preserve topic if the URL already carries one (e.g. tab navigation)
      const topicFromUrl = params.topicId ?? searchParamsRef.current.get('topic');

      if (!topicFromUrl) {
        useChatStore.getState().switchTopic(null, { skipRefreshMessage: true });
      }
    }
    // Note: we no longer clear all unread topics on agent visit — the badge counts
    // unread topics and is cleared per-topic when the user actually opens each one.
  }, [activeId, prevAgentId]);

  // Clear activeAgentId when unmounting (leaving chat page).
  // Must be a layout-effect cleanup (not a passive `useUnmount`): in a route
  // switch both run in one commit, and React runs all layout cleanups of the
  // removed tree BEFORE the new tree's layout effects — so the next route's
  // backfill above always wins over this clear. A passive cleanup would run
  // after it and wipe the freshly synced id.
  useLayoutEffect(
    () => () => {
      useAgentStore.setState({ activeAgentId: undefined }, false, 'AgentIdSync/unmountAgentId');
      useChatStore.setState(
        { activeAgentId: undefined, activeTopicId: undefined },
        false,
        'AgentIdSync/unmountAgentId',
      );
    },
    [],
  );

  return null;
};

export default AgentIdSync;
