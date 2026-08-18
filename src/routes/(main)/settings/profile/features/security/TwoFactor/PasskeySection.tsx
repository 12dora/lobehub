'use client';

import { Text } from '@lobehub/ui';
import { Button, Input, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ChangeEvent, memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { passkey as passkeyClient, useListPasskeys } from '@/libs/better-auth/auth-client';
import { isPasskeySupported } from '@/utils/passkeySupport';

import { securityStyles } from '../styles';
import PasskeyRow, { type PasskeyItem } from './PasskeyRow';

/** The ceremony was dismissed by the user — a no-op, never an error. */
const CANCELLED_CODES = new Set(['ERROR_CEREMONY_ABORTED', 'AUTH_CANCELLED']);

const styles = createStaticStyles(({ css }) => ({
  addRow: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
  empty: css`
    padding-block: 4px;
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextDescription};
  `,
  list: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
}));

/**
 * Passkey management: list, add, rename, remove. The add affordance is capability-gated —
 * offering a button that can only fail on a browser without WebAuthn is worse than saying
 * so plainly (ux Feedback: capability guardrails).
 */
const PasskeySection = memo(() => {
  const { t } = useTranslation('auth');
  const { t: tCommon } = useTranslation('common');

  // Subscribed here, inside the modal content — `createModal` captures its element once,
  // so anything reading live data has to do it from within the mounted component.
  const { data, error, isPending, refetch } = useListPasskeys();

  const [supported] = useState(isPasskeySupported);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [mutating, setMutating] = useState(false);

  const passkeys = (data ?? []) as PasskeyItem[];

  const handleAdd = useCallback(async () => {
    if (adding || !supported) return;

    setAdding(true);
    try {
      const result = await passkeyClient.addPasskey({ name: name.trim() || undefined });
      const addError = result?.error;

      if (addError) {
        // Only the WebAuthn-layer failures carry a `code`; HTTP failures do not.
        const code = 'code' in addError ? addError.code : undefined;
        if (code && CANCELLED_CODES.has(code)) {
          // Dismissing the browser ceremony is a decision, not a failure — acknowledge it
          // without the alarm of an error toast.
          toast({ title: t('profile.security.passkey.cancelled') });
          return;
        }
        toast.error(addError.message || t('profile.security.passkey.error'));
        return;
      }

      setName('');
      toast.success(t('profile.security.passkey.added'));
      refetch?.();
    } catch (caught) {
      console.error('Failed to add a passkey:', caught);
      toast.error(t('profile.security.passkey.error'));
    } finally {
      setAdding(false);
    }
  }, [adding, name, refetch, supported, t]);

  const handleRename = useCallback(
    async (item: PasskeyItem, nextName: string) => {
      setMutating(true);
      try {
        const { error: renameError } = await passkeyClient.updatePasskey({
          id: item.id,
          name: nextName,
        });
        if (renameError) {
          toast.error(renameError.message || tCommon('unknownError'));
          return;
        }
        refetch?.();
      } catch (caught) {
        console.error('Failed to rename the passkey:', caught);
        toast.error(tCommon('unknownError'));
      } finally {
        setMutating(false);
      }
    },
    [refetch, tCommon],
  );

  const handleRemove = useCallback(
    async (item: PasskeyItem) => {
      setMutating(true);
      try {
        const { error: removeError } = await passkeyClient.deletePasskey({ id: item.id });
        if (removeError) {
          toast.error(removeError.message || tCommon('unknownError'));
          return;
        }
        toast.success(t('profile.security.passkey.removed'));
        refetch?.();
      } catch (caught) {
        console.error('Failed to remove the passkey:', caught);
        toast.error(tCommon('unknownError'));
      } finally {
        setMutating(false);
      }
    },
    [refetch, t, tCommon],
  );

  return (
    <div className={securityStyles.section}>
      <Text as="h3" className={securityStyles.title}>
        {t('profile.security.passkey.title')}
      </Text>
      <Text className={securityStyles.desc}>{t('profile.security.passkey.desc')}</Text>

      {/* Error is read before the empty branch: a failed list must not read as "none yet". */}
      {error ? (
        <div className={securityStyles.footerSpread}>
          <Text className={securityStyles.danger} role="alert">
            {error.message || tCommon('unknownError')}
          </Text>
          <Button size="small" onClick={() => refetch?.()}>
            {tCommon('retry')}
          </Button>
        </div>
      ) : (
        <>
          {isPending && <div className={styles.empty}>{tCommon('loading')}</div>}
          {!isPending && passkeys.length === 0 && (
            <div className={styles.empty}>{t('profile.security.passkey.empty')}</div>
          )}
          {passkeys.length > 0 && (
            <div className={styles.list}>
              {passkeys.map((item) => (
                <PasskeyRow
                  busy={mutating}
                  key={item.id}
                  passkey={item}
                  onRemove={handleRemove}
                  onRename={handleRename}
                />
              ))}
            </div>
          )}
        </>
      )}

      {supported ? (
        <div className={styles.addRow}>
          <Input
            aria-label={t('profile.security.passkey.nameLabel')}
            disabled={adding}
            maxLength={64}
            placeholder={t('profile.security.passkey.namePlaceholder')}
            value={name}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void handleAdd();
            }}
          />
          <Button loading={adding} onClick={() => void handleAdd()}>
            {t('profile.security.passkey.add')}
          </Button>
        </div>
      ) : (
        <Text className={securityStyles.desc}>{t('profile.security.passkey.unsupported')}</Text>
      )}
    </div>
  );
});

PasskeySection.displayName = 'PasskeySection';

export default PasskeySection;
