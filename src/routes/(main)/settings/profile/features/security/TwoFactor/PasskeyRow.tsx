'use client';

import { Text } from '@lobehub/ui';
import { Button, Input } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ChangeEvent, memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { securityStyles } from '../styles';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    flex-shrink: 0;
    gap: 4px;
  `,
  confirm: css`
    display: flex;
    flex-direction: column;
    gap: 8px;

    padding: 12px;
    border: 1px solid ${cssVar.colorErrorBorder};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorErrorBg};
  `,
  meta: css`
    min-width: 0;
  `,
  name: css`
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  row: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 10px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
  `,
}));

export interface PasskeyItem {
  createdAt: Date | string;
  id: string;
  name?: string | null;
}

interface PasskeyRowProps {
  busy?: boolean;
  onRemove: (passkey: PasskeyItem) => Promise<void>;
  onRename: (passkey: PasskeyItem, name: string) => Promise<void>;
  passkey: PasskeyItem;
}

const formatCreatedAt = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString();
};

type Mode = 'idle' | 'renaming' | 'removing';

/**
 * One registered passkey. Rename edits in place and removal confirms in place: both are
 * cheap, both are per-row, and a nested dialog on top of an already-open modal would bury
 * the list the user is working through.
 */
const PasskeyRow = memo<PasskeyRowProps>(({ busy, onRemove, onRename, passkey }) => {
  const { t } = useTranslation('auth');
  const [mode, setMode] = useState<Mode>('idle');
  const [draftName, setDraftName] = useState('');
  const [pending, setPending] = useState(false);

  const displayName = passkey.name?.trim() || t('profile.security.passkey.title');
  const createdAt = formatCreatedAt(passkey.createdAt);
  const locked = pending || busy;

  const startRename = useCallback(() => {
    setDraftName(passkey.name ?? '');
    setMode('renaming');
  }, [passkey.name]);

  const handleRename = useCallback(async () => {
    const next = draftName.trim();
    if (!next || next === (passkey.name ?? '') || locked) {
      setMode('idle');
      return;
    }

    setPending(true);
    try {
      await onRename(passkey, next);
      setMode('idle');
    } finally {
      setPending(false);
    }
  }, [draftName, locked, onRename, passkey]);

  const handleRemove = useCallback(async () => {
    if (locked) return;
    setPending(true);
    try {
      await onRemove(passkey);
    } finally {
      setPending(false);
    }
  }, [locked, onRemove, passkey]);

  if (mode === 'removing') {
    return (
      <div className={styles.confirm}>
        <Text as="span" className={styles.name}>
          {t('profile.security.passkey.removeTitle', { name: displayName })}
        </Text>
        <Text className={securityStyles.desc}>{t('profile.security.passkey.removeConfirm')}</Text>
        <div className={securityStyles.footer}>
          <Button disabled={pending} size="small" onClick={() => setMode('idle')}>
            {t('profile.security.close')}
          </Button>
          <Button
            danger
            loading={pending}
            size="small"
            type="primary"
            onClick={() => void handleRemove()}
          >
            {t('profile.security.passkey.remove')}
          </Button>
        </div>
      </div>
    );
  }

  if (mode === 'renaming') {
    return (
      <div className={styles.row}>
        <Input
          autoFocus
          aria-label={t('profile.security.passkey.renameTitle')}
          disabled={pending}
          maxLength={64}
          placeholder={t('profile.security.passkey.namePlaceholder')}
          value={draftName}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void handleRename();
            }
            if (event.key === 'Escape') setMode('idle');
          }}
        />
        <div className={styles.actions}>
          <Button disabled={pending} size="small" onClick={() => setMode('idle')}>
            {t('profile.security.close')}
          </Button>
          <Button loading={pending} size="small" type="primary" onClick={() => void handleRename()}>
            {t('profile.save')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <div className={styles.meta}>
        <div className={styles.name}>{displayName}</div>
        {createdAt && (
          <Text className={securityStyles.desc}>
            {t('profile.security.passkey.createdAt', { date: createdAt })}
          </Text>
        )}
      </div>
      <div className={styles.actions}>
        <Button disabled={locked} size="small" type="text" onClick={startRename}>
          {t('profile.security.passkey.rename')}
        </Button>
        <Button
          danger
          disabled={locked}
          size="small"
          type="text"
          onClick={() => setMode('removing')}
        >
          {t('profile.security.passkey.remove')}
        </Button>
      </div>
    </div>
  );
});

PasskeyRow.displayName = 'PasskeyRow';

export default PasskeyRow;
