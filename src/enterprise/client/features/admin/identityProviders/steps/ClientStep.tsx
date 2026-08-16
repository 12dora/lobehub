'use client';

import { Alert, Flexbox, Input, Text } from '@lobehub/ui';
import { Button, Checkbox } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { identityProviderStyles as styles } from '../styles';
import type { EditableDraft, PatchDraft } from './types';

interface ClientStepProps {
  callbacks?: { production: string; test: string };
  clearSecret: boolean;
  draft: EditableDraft;
  onCopyUrl: (url: string) => void;
  patch: PatchDraft;
  secret: string;
  secretConfigured: boolean;
  secretUpdatedAt?: Date | null;
  setClearSecret: (value: boolean) => void;
  setSecret: (value: string) => void;
}

export const ClientStep = memo<ClientStepProps>(
  ({
    callbacks,
    clearSecret,
    draft,
    onCopyUrl,
    patch,
    secret,
    secretConfigured,
    secretUpdatedAt,
    setClearSecret,
    setSecret,
  }) => {
    const { t } = useTranslation('admin');
    const isDingTalk = draft.type === 'dingtalk';

    return (
      <Flexbox gap={12}>
        {isDingTalk ? (
          <Alert
            showIcon
            description={t('identityProviders.dingtalk.fixedProtocolNotice')}
            message={t('identityProviders.dingtalk.fixedProtocolTitle')}
            type="info"
          />
        ) : null}
        <label className={styles.field}>
          <Text>
            {isDingTalk
              ? t('identityProviders.dingtalk.appKey')
              : t('identityProviders.fields.clientId')}
          </Text>
          <Input value={draft.clientId} onChange={(e) => patch('clientId', e.target.value)} />
        </label>
        <label className={styles.field}>
          <Text>
            {isDingTalk
              ? t('identityProviders.dingtalk.appSecret')
              : t('identityProviders.fields.clientSecret')}
          </Text>
          <Input
            autoComplete="new-password"
            placeholder={secretConfigured ? t('identityProviders.secret.configured') : ''}
            type="password"
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setClearSecret(false);
            }}
          />
        </label>
        {secretConfigured ? (
          <Text type="secondary">
            {t('identityProviders.secret.updatedAt', {
              updatedAt: secretUpdatedAt?.toLocaleString() ?? '—',
            })}
          </Text>
        ) : null}
        <label>
          <Checkbox
            checked={clearSecret}
            onChange={(checked) => {
              setClearSecret(checked);
              if (checked) setSecret('');
            }}
          />{' '}
          {t('identityProviders.secret.clear')}
        </label>
        <Text>{t('identityProviders.callback.production')}</Text>
        <div className={styles.callback}>
          <span className={styles.callbackUrl}>{callbacks?.production ?? '—'}</span>
          {callbacks?.production ? (
            <Button size="small" onClick={() => void onCopyUrl(callbacks.production)}>
              {t('identityProviders.callback.copy')}
            </Button>
          ) : null}
        </div>
        <Text>{t('identityProviders.callback.test')}</Text>
        <div className={styles.callback}>
          <span className={styles.callbackUrl}>{callbacks?.test ?? '—'}</span>
          {callbacks?.test ? (
            <Button size="small" onClick={() => void onCopyUrl(callbacks.test)}>
              {t('identityProviders.callback.copy')}
            </Button>
          ) : null}
        </div>
      </Flexbox>
    );
  },
);

ClientStep.displayName = 'ClientStep';
