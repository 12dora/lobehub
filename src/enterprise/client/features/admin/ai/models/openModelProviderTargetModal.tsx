'use client';

import { Input, Text } from '@lobehub/ui';
import { Button, createModal, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import i18next from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  `,
}));

export interface ModelProviderTargetContentProps {
  candidates: Array<{ id: string; key: string }>;
  onSubmit: (providerId: string) => Promise<void>;
}

const ModelProviderTargetContent = memo<ModelProviderTargetContentProps>(
  ({ candidates, onSubmit }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [providerId, setProviderId] = useState(candidates.length === 1 ? candidates[0]!.id : '');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(false);

    const submit = async () => {
      const id = providerId.trim();
      if (!id) {
        setError(true);
        return;
      }
      setSubmitting(true);
      try {
        await onSubmit(id);
        close();
      } catch {
        setError(true);
        setSubmitting(false);
      }
    };

    return (
      <div className={styles.body}>
        <Text type="secondary">{t('aiCatalog.models.providerTarget.desc')}</Text>
        <Input
          disabled={submitting}
          placeholder={t('aiCatalog.models.providerTarget.placeholder')}
          value={providerId}
          onChange={(event) => {
            setError(false);
            setProviderId(event.target.value);
          }}
        />
        {candidates.length > 0 ? (
          <Text type="secondary">
            {t('aiCatalog.models.providerTarget.known', {
              providers: candidates.map((item) => `${item.key} (${item.id})`).join(', '),
            })}
          </Text>
        ) : null}
        {error ? (
          <Text className={styles.error} role="alert">
            {t('aiCatalog.models.providerTarget.error')}
          </Text>
        ) : null}
        <div className={styles.footer}>
          <Button disabled={submitting} onClick={close}>
            {t('users.modals.cancel')}
          </Button>
          <Button loading={submitting} type="primary" onClick={() => void submit()}>
            {t('aiCatalog.models.actions.create')}
          </Button>
        </div>
      </div>
    );
  },
);

ModelProviderTargetContent.displayName = 'AdminAiModelProviderTargetContent';

export const openModelProviderTargetModal = (props: ModelProviderTargetContentProps) =>
  createModal({
    content: <ModelProviderTargetContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('aiCatalog.models.providerTarget.title', { ns: 'admin' }),
    width: 'min(92vw, 520px)',
  });
