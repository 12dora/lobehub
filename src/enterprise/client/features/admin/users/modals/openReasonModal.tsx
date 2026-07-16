'use client';

import { Flexbox, Text, TextArea } from '@lobehub/ui';
import { Button, createModal, type ModalInstance, useModalContext } from '@lobehub/ui/base-ui';
import { memo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getAdminUsersMutationErrorKey } from '../utils';

interface ReasonModalContentProps {
  danger?: boolean;
  description?: string;
  extra?: ReactNode;
  impact?: string;
  onSubmit: (reason: string) => Promise<void>;
  submitLabel: string;
  targetLabel: string;
  title: string;
  validateExtra?: () => string | null;
}

const ReasonModalContent = memo<ReasonModalContentProps>(
  ({
    danger,
    description,
    extra,
    impact,
    onSubmit,
    submitLabel,
    targetLabel,
    title,
    validateExtra,
  }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [errorKey, setErrorKey] = useState<string | null>(null);

    const canSubmit = reason.trim().length > 0 && !loading;

    const handleSubmit = useCallback(async () => {
      if (loading) return;
      const trimmed = reason.trim();
      if (!trimmed) {
        setErrorKey('users.modals.reasonRequired');
        return;
      }
      const extraError = validateExtra?.() ?? null;
      if (extraError) {
        setErrorKey(extraError);
        return;
      }

      setLoading(true);
      setErrorKey(null);
      try {
        await onSubmit(trimmed);
        close();
      } catch (error) {
        setErrorKey(getAdminUsersMutationErrorKey(error));
        // Keep modal open on failure
      } finally {
        setLoading(false);
      }
    }, [close, loading, onSubmit, reason, validateExtra]);

    return (
      <Flexbox gap={16}>
        <Text as="h2" style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
          {title}
        </Text>
        {description ? <Text type="secondary">{description}</Text> : null}
        <Text>
          <strong>{t('users.modals.target')}</strong> {targetLabel}
        </Text>
        {impact ? <Text type="secondary">{impact}</Text> : null}
        <Flexbox gap={6}>
          <Text style={{ fontSize: 13 }}>{t('users.modals.reasonLabel')}</Text>
          <TextArea
            maxLength={2000}
            placeholder={t('users.modals.reasonPlaceholder')}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Flexbox>
        {extra}
        {errorKey ? (
          <Text role="alert" type="danger">
            {t(errorKey as never)}
          </Text>
        ) : null}
        <Flexbox horizontal gap={8} justify="flex-end">
          <Button disabled={loading} onClick={close}>
            {t('users.modals.cancel')}
          </Button>
          <Button
            danger={danger}
            disabled={!canSubmit}
            loading={loading}
            type="primary"
            onClick={() => void handleSubmit()}
          >
            {submitLabel}
          </Button>
        </Flexbox>
      </Flexbox>
    );
  },
);

ReasonModalContent.displayName = 'AdminUsersReasonModalContent';

export const openReasonModal = (props: ReasonModalContentProps): ModalInstance =>
  createModal({
    content: <ReasonModalContent {...props} />,
    footer: null,
    maskClosable: false,
    title: null,
    width: 'min(92vw, 480px)',
  });
