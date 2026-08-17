'use client';

import { Flexbox, Input, Tag, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { identityProviderStyles as styles } from '../styles';
import type { EditableDraft, PatchDraft } from './types';

interface BasicStepProps {
  draft: EditableDraft;
  patch: PatchDraft;
  /** Kind-specific providerKey validation message, or `null` when valid. */
  providerKeyError?: string | null;
  /** When editing an existing provider, providerKey is locked. */
  providerKeyLocked: boolean;
}

export const BasicStep = memo<BasicStepProps>(
  ({ draft, patch, providerKeyError, providerKeyLocked }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.form}>
        <label className={styles.field}>
          <Text>{t('identityProviders.fields.displayName')}</Text>
          <Input value={draft.displayName} onChange={(e) => patch('displayName', e.target.value)} />
        </label>
        <label className={styles.field}>
          <Text>{t('identityProviders.fields.providerKey')}</Text>
          <Input
            disabled={providerKeyLocked}
            value={draft.providerKey}
            onChange={(e) => patch('providerKey', e.target.value.toLowerCase())}
          />
          {providerKeyError ? (
            <Text role="alert" type="danger">
              {providerKeyError}
            </Text>
          ) : null}
        </label>
        <label className={styles.field}>
          <Text>{t('identityProviders.fields.buttonLabel')}</Text>
          <Input value={draft.buttonLabel} onChange={(e) => patch('buttonLabel', e.target.value)} />
        </label>
        <label className={styles.field}>
          <Text>{t('identityProviders.fields.icon')}</Text>
          <Input
            placeholder={t('identityProviders.fields.iconPlaceholder')}
            value={draft.icon ?? ''}
            onChange={(e) => patch('icon', e.target.value || null)}
          />
        </label>
        <div className={`${styles.field} ${styles.full}`}>
          <Text>{t('identityProviders.fields.type')}</Text>
          <Flexbox horizontal gap={8}>
            <Tag color={draft.type === 'generic_oidc' ? 'default' : 'blue'}>
              {draft.type === 'authentik'
                ? 'Authentik'
                : draft.type === 'dingtalk'
                  ? t('identityProviders.templates.dingtalk.label')
                  : t('identityProviders.templates.genericOidc.label')}
            </Tag>
            <Text type="secondary">{t('identityProviders.fields.typeLocked')}</Text>
          </Flexbox>
        </div>
      </div>
    );
  },
);

BasicStep.displayName = 'BasicStep';
