'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { isNearBottom, LIVE_SCROLL_BOTTOM_THRESHOLD_PX } from '../shared/liveMessageUtils';

export interface LiveStreamScrollArgs {
  itemCount: number;
  loadingOlder?: boolean;
  topicId?: string;
}

/**
 * Follow-the-tail scrolling for the live message stream: sticks to the bottom while the auditor
 * is there, offers a jump affordance when they are not, and restores the reading position after
 * an older page prepends.
 */
export const useLiveStreamScroll = ({ itemCount, loadingOlder, topicId }: LiveStreamScrollArgs) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const prevCountRef = useRef(0);
  const wasLoadingOlderRef = useRef(false);
  const anchorScrollHeightRef = useRef(0);
  const anchorScrollTopRef = useRef(0);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setShowJump(false);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el, LIVE_SCROLL_BOTTOM_THRESHOLD_PX);
    stickToBottomRef.current = near;
    if (near) setShowJump(false);
  }, []);

  // Capture scroll metrics before older messages prepend.
  useLayoutEffect(() => {
    if (loadingOlder && !wasLoadingOlderRef.current) {
      const el = scrollRef.current;
      if (el) {
        anchorScrollHeightRef.current = el.scrollHeight;
        anchorScrollTopRef.current = el.scrollTop;
      }
    }
    wasLoadingOlderRef.current = Boolean(loadingOlder);
  }, [loadingOlder]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    // Restore relative position after older-page prepend (do not rely on overflow-anchor).
    if (el && !loadingOlder && anchorScrollHeightRef.current > 0) {
      const delta = el.scrollHeight - anchorScrollHeightRef.current;
      if (delta > 0) {
        el.scrollTop = anchorScrollTopRef.current + delta;
        prevCountRef.current = itemCount;
        anchorScrollHeightRef.current = 0;
        return;
      }
    }

    const grew = itemCount > prevCountRef.current;
    prevCountRef.current = itemCount;
    if (grew && stickToBottomRef.current) {
      scrollToBottom();
    } else if (grew && !stickToBottomRef.current) {
      setShowJump(true);
    }
  }, [itemCount, loadingOlder, scrollToBottom]);

  useEffect(() => {
    // Reset stickiness when topic changes.
    stickToBottomRef.current = true;
    prevCountRef.current = 0;
    anchorScrollHeightRef.current = 0;
    setShowJump(false);
  }, [topicId]);

  return { onScroll, scrollRef, scrollToBottom, showJump };
};
