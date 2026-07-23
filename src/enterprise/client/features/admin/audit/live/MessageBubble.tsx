'use client';

import { Tag, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAuditConversationMessage } from '@/enterprise/client/services/adminAudit';

import { formatAdminDateTime } from '../shared/format';

const styles = createStaticStyles(({ css }) => ({
  row: css`
    display: flex;
    width: 100%;
  `,
  rowUser: css`
    justify-content: flex-end;
  `,
  rowAssistant: css`
    justify-content: flex-start;
  `,
  rowSystem: css`
    justify-content: center;
  `,
  bubble: css`
    max-width: min(72%, 560px);
    padding-block: 10px;
    padding-inline: 12px;
    border-radius: ${cssVar.borderRadiusLG};

    word-break: break-word;
    white-space: pre-wrap;
  `,
  bubbleUser: css`
    border: 1px solid ${cssVar.colorPrimaryBorder};
    background: ${cssVar.colorPrimaryBg};
  `,
  bubbleAssistant: css`
    border: 1px solid ${cssVar.colorBorderSecondary};
    background: ${cssVar.colorFillSecondary};
  `,
  bubbleSystem: css`
    max-width: 90%;
    border: 1px dashed ${cssVar.colorBorderSecondary};

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorFillQuaternary};
  `,
  meta: css`
    display: flex;
    gap: 8px;
    align-items: center;
    margin-block-end: 6px;
  `,
  body: css`
    font-size: 13px;
    line-height: 1.55;
  `,
  redacted: css`
    font-weight: 600;
    color: ${cssVar.colorWarning};
  `,
  toggle: css`
    cursor: pointer;
    margin-block-start: 4px;
    font-size: 12px;
    color: ${cssVar.colorPrimary};
  `,
}));

const renderBody = (content: string) => {
  const parts = content.split(/(\[REDACTED[^\]]*\])/g);
  return parts.map((part, i) =>
    part.startsWith('[REDACTED') ? (
      <span className={styles.redacted} key={i}>
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
};

export interface MessageBubbleProps {
  /** When metadata_only / body not loaded */
  bodyHidden?: boolean;
  message: AdminAuditConversationMessage;
}

const MessageBubble = memo<MessageBubbleProps>(({ message, bodyHidden }) => {
  const { t } = useTranslation('admin');
  const role = (message.role || 'assistant').toLowerCase();
  const isUser = role === 'user';
  const isSystem = role === 'system' || role === 'tool';
  const [collapsed, setCollapsed] = useState(isSystem);

  const rowClass = isUser
    ? `${styles.row} ${styles.rowUser}`
    : isSystem
      ? `${styles.row} ${styles.rowSystem}`
      : `${styles.row} ${styles.rowAssistant}`;

  const bubbleClass = isUser
    ? `${styles.bubble} ${styles.bubbleUser}`
    : isSystem
      ? `${styles.bubble} ${styles.bubbleSystem}`
      : `${styles.bubble} ${styles.bubbleAssistant}`;

  return (
    <div className={rowClass}>
      <div className={bubbleClass}>
        <div className={styles.meta}>
          <Tag size="small">{message.role}</Tag>
          <Text style={{ fontSize: 11, margin: 0 }} type="secondary">
            {formatAdminDateTime(message.createdAt)}
          </Text>
        </div>
        {isSystem ? (
          <div
            className={styles.toggle}
            role="button"
            tabIndex={0}
            onClick={() => setCollapsed((c) => !c)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') setCollapsed((c) => !c);
            }}
          >
            {collapsed ? t('audit.live.message.expand') : t('audit.live.message.collapse')}
          </div>
        ) : null}
        {isSystem && collapsed ? null : (
          <div className={styles.body}>
            {bodyHidden ? (
              <Text type="secondary">{t('audit.live.message.bodyHidden')}</Text>
            ) : message.content != null && message.content !== '' ? (
              renderBody(message.content)
            ) : message.hasContent ? (
              <Text type="secondary">{t('audit.conversations.topic.bodyNotLoaded')}</Text>
            ) : (
              '—'
            )}
          </div>
        )}
      </div>
    </div>
  );
});

MessageBubble.displayName = 'AuditLiveMessageBubble';

export default MessageBubble;
