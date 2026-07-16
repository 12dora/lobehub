'use client';

import { Text, TextArea } from '@lobehub/ui';
import { Button, createModal, type ModalInstance, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  AdminReauthBlockedError,
  AdminReauthCancelledError,
  withAdminReauthRetry,
} from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

import { getAdminUsersMutationErrorKey } from '../utils';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  `,
  title: css`
    margin: 0;
    font-size: ${cssVar.fontSizeLG};
    font-weight: 600;
  `,
}));

export interface ReasonModalContentProps {
  danger?: boolean;
  description?: string;
  /** Controlled extra fields rendered between reason and errors. */
  extra?: ReactNode;
  impact?: string;
  /**
   * Submit handler. Receives trimmed reason. Should throw on failure.
   * ADMIN_REAUTH_REQUIRED triggers popup reauth + exactly one retry.
   */
  onSubmit: (reason: string) => Promise<void>;
  submitLabel: string;
  targetLabel: string;
  title: string;
  /** Return i18n key or null. */
  validateExtra?: () => string | null;
}

export const ReasonModalContent = memo<ReasonModalContentProps>(
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
        // Pending reason stays only in React state (in memory) across reauth.
        await withAdminReauthRetry(() => onSubmit(trimmed));
        close();
      } catch (error) {
        if (error instanceof AdminReauthCancelledError) {
          setErrorKey('users.errors.reauthCancelled');
          // Keep modal open with reason intact
        } else if (error instanceof AdminReauthBlockedError) {
          setErrorKey('users.errors.reauthBlocked');
        } else {
          const mapped = mapEnterpriseError(error);
          if (mapped?.action === 'reauth') {
            setErrorKey('users.errors.reauthRequired');
          } else {
            setErrorKey(getAdminUsersMutationErrorKey(error));
          }
        }
      } finally {
        setLoading(false);
      }
    }, [close, loading, onSubmit, reason, validateExtra]);

    return (
      <div className={styles.body}>
        <Text as="h2" className={styles.title}>
          {title}
        </Text>
        {description ? <Text type="secondary">{description}</Text> : null}
        <Text>
          <strong>{t('users.modals.target')}</strong> {targetLabel}
        </Text>
        {impact ? <Text type="secondary">{impact}</Text> : null}
        <div className={styles.field}>
          <Text>{t('users.modals.reasonLabel')}</Text>
          <TextArea
            maxLength={2000}
            placeholder={t('users.modals.reasonPlaceholder')}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {extra}
        {errorKey ? (
          <Text className={styles.error} role="alert">
            {t(errorKey as never)}
          </Text>
        ) : null}
        <div className={styles.footer}>
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
        </div>
      </div>
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
