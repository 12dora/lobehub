'use client';

import { Text, TextArea } from '@lobehub/ui';
import { Button, createModal, type ModalInstance, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  type AdminReauthAuthMethod,
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
  /** Trusted server auth method for reauth routing. */
  authMethod?: AdminReauthAuthMethod;
  /**
   * Build the frozen mutation snapshot after validation (reason already trimmed).
   * Snapshot is immutable for reauth retry.
   */
  buildPayload: (reason: string) => unknown;
  danger?: boolean;
  description?: string;
  /**
   * Controlled extra fields. Receives `locked` when reauth/pending freezes UI.
   */
  extra?: ReactNode | ((api: { locked: boolean }) => ReactNode);
  impact?: string;
  /**
   * Execute mutation with frozen payload. Throws on failure.
   */
  onSubmit: (payload: unknown) => Promise<void>;
  submitLabel: string;
  targetLabel: string;
  title: string;
  validateExtra?: () => string | null;
}

export const ReasonModalContent = memo<ReasonModalContentProps>(
  ({
    authMethod,
    danger,
    description,
    extra,
    impact,
    buildPayload,
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
    const [locked, setLocked] = useState(false);
    const [errorKey, setErrorKey] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    // Frozen complete mutation input — never re-read live form fields on retry.
    const snapshotRef = useRef<unknown>(null);

    useEffect(() => {
      return () => {
        abortRef.current?.abort();
        abortRef.current = null;
        snapshotRef.current = null;
      };
    }, []);

    const canSubmit = reason.trim().length > 0 && !loading;

    const handleClose = useCallback(() => {
      abortRef.current?.abort();
      abortRef.current = null;
      close();
    }, [close]);

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

      // Freeze complete payload before any reauth / network work.
      const frozen = buildPayload(trimmed);
      snapshotRef.current = frozen;

      setLoading(true);
      setLocked(true);
      setErrorKey(null);

      const ac = new AbortController();
      abortRef.current = ac;

      try {
        await withAdminReauthRetry(
          async () => {
            // Always use immutable snapshot — never re-sample live fields.
            const payload = snapshotRef.current;
            if (payload === null) throw new AdminReauthCancelledError();
            await onSubmit(payload);
          },
          {
            authMethod: authMethod ?? null,
            signal: ac.signal,
          },
        );
        snapshotRef.current = null;
        close();
      } catch (error) {
        if (error instanceof AdminReauthCancelledError) {
          setErrorKey('users.errors.reauthCancelled');
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
        // Unlock fields after failure so user can fix/retry; snapshot cleared only on success.
        setLocked(false);
      } finally {
        setLoading(false);
        abortRef.current = null;
      }
    }, [authMethod, buildPayload, close, loading, onSubmit, reason, validateExtra]);

    const extraNode = typeof extra === 'function' ? extra({ locked }) : extra;

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
            disabled={locked}
            maxLength={2000}
            placeholder={t('users.modals.reasonPlaceholder')}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {extraNode}
        {errorKey ? (
          <Text className={styles.error} role="alert">
            {t(errorKey as never)}
          </Text>
        ) : null}
        <div className={styles.footer}>
          <Button disabled={loading} onClick={handleClose}>
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
