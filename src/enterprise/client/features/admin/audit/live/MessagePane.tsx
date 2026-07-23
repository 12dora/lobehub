'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
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
    const scrollRef = useRef<HTMLDivElement>(null);
    const stickToBottomRef = useRef(true);
    const [showJump, setShowJump] = useState(false);
    const prevCountRef = useRef(0);
    const wasLoadingOlderRef = useRef(false);
    const anchorScrollHeightRef = useRef(0);
    const anchorScrollTopRef = useRef(0);

    const ordered = useMemo(() => sortMessagesChronological(messages), [messages]);

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
      // Reset stickiness when topic changes
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
            <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
          ) : null}
          {ordered.map((msg) => (
            <MessageBubble bodyHidden={bodyHidden && !msg.content} key={msg.id} message={msg} />
          ))}
          {!ordered.length && !loading ? (
            <Text type="secondary">{t('audit.live.messages.empty')}</Text>
          ) : null}
          {showJump ? (
            <div className={styles.jump}>
              <Button size="small" type="primary" onClick={scrollToBottom}>
                {t('audit.live.messages.jumpNew')}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  },
);

MessagePane.displayName = 'AuditLiveMessagePane';

export default MessagePane;
