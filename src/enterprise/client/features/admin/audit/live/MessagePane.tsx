'use client';

import { Skeleton, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { AnimatePresence, m, useReducedMotion } from 'motion/react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type {
  AdminAuditConversationDetail,
  AdminAuditConversationMessage,
} from '@/enterprise/client/services/adminAudit';

import { formatAdminDateTime } from '../shared/format';
import {
  isNearBottom,
  LIVE_SCROLL_BOTTOM_THRESHOLD_PX,
  sortMessagesChronological,
} from '../shared/liveMessageUtils';
import MessageBubble from './MessageBubble';

const styles = createStaticStyles(({ css }) => ({
  root: css`
    display: flex;
    flex: 1;
    flex-direction: column;

    min-width: 0;
    height: 100%;

    background: ${cssVar.colorBgLayout};
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: flex-start;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgContainer};
  `,
  stream: css`
    position: relative;

    overflow: auto;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 10px;

    padding-block: 16px;
    padding-inline: 16px;
  `,
  empty: css`
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;

    padding: 24px;
  `,
  jump: css`
    position: absolute;
    z-index: 2;
    inset-block-end: 16px;
    inset-inline-end: 24px;
  `,
  older: css`
    display: flex;
    justify-content: center;
    margin-block-end: 8px;
  `,
}));

export interface MessagePaneProps {
  bodyHidden: boolean;
  hasOlder: boolean;
  loading?: boolean;
  loadingOlder?: boolean;
  messages: AdminAuditConversationMessage[];
  onLoadOlder: () => void;
  topic?: AdminAuditConversationDetail | null;
  userId: string;
}

const MessagePane = memo<MessagePaneProps>(
  ({ topic, userId, messages, bodyHidden, hasOlder, onLoadOlder, loading, loadingOlder }) => {
    const { t } = useTranslation('admin');
    const reduceMotion = useReducedMotion();
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const [showJump, setShowJump] = useState(false);
    const prevCountRef = useRef(0);
    const wasLoadingOlderRef = useRef(false);
    const anchorScrollHeightRef = useRef(0);
    const anchorScrollTopRef = useRef(0);
    // Last committed stream snapshot. Render only reads it; abandoned/concurrent renders
    // must not consume a message's one-time entrance animation.
    const committedStreamRef = useRef<{
      committed: boolean;
      ids: string[];
      topicId?: string;
    }>({ committed: false, ids: [], topicId: undefined });

    const ordered = useMemo(() => sortMessagesChronological(messages), [messages]);

    // Framer captures `initial` on mount, so entrance candidates are derived during render
    // from the last committed snapshot. The snapshot itself advances after commit.
    const enterIds = useMemo(() => {
      const committed = committedStreamRef.current;
      const currentIds = ordered.map((msg) => msg.id);
      const sameCommittedTopic = committed.committed && committed.topicId === topic?.id;
      const knownList = sameCommittedTopic ? committed.ids : [];
      const known = new Set(knownList);
      const fresh = currentIds.filter((id) => !known.has(id));

      let nextEnter = new Set<string>();
      if (
        !reduceMotion &&
        !loadingOlder &&
        sameCommittedTopic &&
        knownList.length > 0 &&
        fresh.length > 0
      ) {
        // Append-only: previous order is an exact prefix; all fresh ids form the contiguous tail.
        const isAppend =
          currentIds.length === knownList.length + fresh.length &&
          knownList.every((id, i) => currentIds[i] === id);
        if (isAppend) nextEnter = new Set(fresh);
      }

      return nextEnter;
    }, [loadingOlder, ordered, reduceMotion, topic?.id]);

    useLayoutEffect(() => {
      committedStreamRef.current = {
        committed: true,
        ids: ordered.map((message) => message.id),
        topicId: topic?.id,
      };
    }, [ordered, topic?.id]);

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
          prevCountRef.current = ordered.length;
          anchorScrollHeightRef.current = 0;
          return;
        }
      }

      const grew = ordered.length > prevCountRef.current;
      prevCountRef.current = ordered.length;
      if (grew && stickToBottomRef.current) {
        scrollToBottom();
      } else if (grew && !stickToBottomRef.current) {
        setShowJump(true);
      }
    }, [loadingOlder, ordered.length, scrollToBottom]);

    useEffect(() => {
      // Reset stickiness when topic changes.
      stickToBottomRef.current = true;
      prevCountRef.current = 0;
      anchorScrollHeightRef.current = 0;
      setShowJump(false);
    }, [topic?.id]);

    if (!topic) {
      return (
        <div className={styles.empty}>
          <Text type="secondary">{t('audit.live.messages.pickTopic')}</Text>
        </div>
      );
    }

    return (
      <div className={styles.root}>
        <div className={styles.header}>
          <div>
            <Text style={{ fontWeight: 600, margin: 0 }}>
              {topic.title || t('audit.conversations.untitled')}
            </Text>
            <Text style={{ display: 'block', fontSize: 12 }} type="secondary">
              {[topic.provider, topic.model, topic.agentId].filter(Boolean).join(' · ') || '—'}
              {' · '}
              {formatAdminDateTime(topic.createdAt)}
            </Text>
          </div>
          <Link to={`/admin/audit/conversations/${userId}/topics/${topic.id}`}>
            {t('audit.live.messages.openEvidence')}
          </Link>
        </div>

        <div className={styles.stream} ref={scrollRef} onScroll={onScroll}>
          {hasOlder ? (
            <div className={styles.older}>
              <Button loading={loadingOlder} size="small" type="default" onClick={onLoadOlder}>
                {t('audit.live.messages.loadOlder')}
              </Button>
            </div>
          ) : null}
          {loading && !ordered.length ? (
            <div aria-label={t('primitives.dataTable.loading')} role="status">
              <Skeleton active={!reduceMotion} paragraph={{ rows: 4 }} title={false} />
            </div>
          ) : null}
          <AnimatePresence initial={false}>
            {ordered.map((msg) => {
              const shouldEnter = enterIds.has(msg.id);
              return (
                <m.div
                  animate={{ opacity: 1, y: 0 }}
                  initial={shouldEnter ? { opacity: 0, y: 6 } : false}
                  key={msg.id}
                  transition={{ duration: reduceMotion || !shouldEnter ? 0 : 0.16 }}
                >
                  <MessageBubble bodyHidden={bodyHidden} message={msg} />
                </m.div>
              );
            })}
          </AnimatePresence>
          {!ordered.length && !loading ? (
            <Text type="secondary">{t('audit.live.messages.empty')}</Text>
          ) : null}
          <AnimatePresence initial={false}>
            {showJump ? (
              <m.div
                animate={{ opacity: 1, y: 0 }}
                className={styles.jump}
                exit={reduceMotion ? undefined : { opacity: 0, y: 6 }}
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                key="jump"
                transition={{ duration: reduceMotion ? 0 : 0.14 }}
              >
                <Button size="small" type="primary" onClick={scrollToBottom}>
                  {t('audit.live.messages.jumpNew')}
                </Button>
              </m.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    );
  },
);

MessagePane.displayName = 'AuditLiveMessagePane';

export default MessagePane;
