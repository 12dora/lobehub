'use client';

import { Text, TextArea } from '@lobehub/ui';
import { Button, createModal, type ModalInstance, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import {
  type AdminReauthBusyPhase,
  useReauthMutation,
} from '@/enterprise/client/features/admin/primitives/useReauthMutation';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';

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

/** idle | waiting on reauth popup | server mutation in flight */
export type ReasonModalPhase = 'idle' | 'reauthing' | 'mutating';

export interface ReasonModalContentProps {
  /**
   * Shared abort controller for this modal instance.
   * openReasonModal wires onOpenChange(false) to abort immediately (Escape/close).
   */
  abortControllerRef?: React.MutableRefObject<AbortController | null>;
  authMethod?: AdminReauthAuthMethod;
  /**
   * Fixed reason recorded in the audit trail when the reason input is hidden.
   * Required (non-empty) whenever `hideReason` is true — the server still bounds it.
   */
  autoReason?: string;
  buildPayload: (reason: string) => unknown;
  danger?: boolean;
  description?: string;
  extra?: ReactNode | ((api: { locked: boolean; phase: ReasonModalPhase }) => ReactNode);
  /** Confirm-only mode: hide the reason textarea and submit `autoReason` instead. */
  hideReason?: boolean;
  impact?: string;
  /** Called when phase changes (tests / parent). */
  onPhaseChange?: (phase: ReasonModalPhase) => void;
  onSubmit: (payload: unknown) => Promise<void>;
  submitLabel: string;
  targetLabel: string;
  title: string;
  validateExtra?: () => string | null;
}

export const ReasonModalContent = memo<ReasonModalContentProps>(
  ({
    authMethod,
    autoReason,
    danger,
    description,
    extra,
    hideReason,
    impact,
    buildPayload,
    onSubmit,
    submitLabel,
    targetLabel,
    title,
    validateExtra,
    abortControllerRef,
    onPhaseChange,
  }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [reason, setReason] = useState('');
    const [phase, setPhase] = useState<ReasonModalPhase>('idle');

    const resetBusyPhase = useCallback(() => {
      setPhase((p) => (p === 'mutating' || p === 'reauthing' ? 'idle' : p));
    }, []);

    const {
      abortActive,
      cancelReauth,
      clearCanonical,
      errorKey,
      runReauthedSubmit,
      setErrorKeySafe,
    } = useReauthMutation({
      abortControllerRef,
      resetBusyPhase,
      setPhase: (next: AdminReauthBusyPhase) => {
        setPhase(next);
        onPhaseChange?.(next);
      },
    });

    const locked = phase !== 'idle';
    const canSubmit = (hideReason || reason.trim().length > 0) && phase === 'idle';

    const handleClose = useCallback(() => {
      // Immediate abort — Escape/close must not wait for unmount cleanup.
      abortActive();
      clearCanonical();
      close();
    }, [abortActive, clearCanonical, close]);

    const handleCancelReauth = useCallback(() => {
      cancelReauth(phase);
    }, [cancelReauth, phase]);

    const mapReasonModalError = useCallback((error: unknown) => {
      const mapped = mapEnterpriseError(error);
      if (mapped?.action === 'reauth') {
        return 'users.errors.reauthRequired';
      }
      return getAdminUsersMutationErrorKey(error);
    }, []);

    const handleSubmit = useCallback(async () => {
      if (phase !== 'idle') return;
      const trimmed = hideReason ? (autoReason ?? '').trim() : reason.trim();
      if (!trimmed) {
        setErrorKeySafe('users.modals.reasonRequired');
        return;
      }
      const extraError = validateExtra?.() ?? null;
      if (extraError) {
        setErrorKeySafe(extraError);
        return;
      }

      // Build live payload once; runner stores a private structured-cloned freeze.
      const built = buildPayload(trimmed);

      await runReauthedSubmit({
        authMethod,
        mapError: mapReasonModalError,
        payload: built,
        onSubmit: async (attemptPayload) => {
          await onSubmit(attemptPayload);
        },
        onSuccess: () => {
          close();
        },
      });
    }, [
      authMethod,
      autoReason,
      buildPayload,
      close,
      hideReason,
      mapReasonModalError,
      onSubmit,
      phase,
      reason,
      runReauthedSubmit,
      setErrorKeySafe,
      validateExtra,
    ]);

    const extraNode = typeof extra === 'function' ? extra({ locked, phase }) : extra;

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
        {hideReason ? null : (
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
        )}
        {extraNode}
        {phase === 'reauthing' ? (
          <Text role="status" type="secondary">
            {t('users.reauth.inProgress')}
          </Text>
        ) : null}
        {errorKey ? (
          <Text className={styles.error} role="alert">
            {t(errorKey as never)}
          </Text>
        ) : null}
        <div className={styles.footer}>
          {phase === 'reauthing' ? (
            <Button type="default" onClick={handleCancelReauth}>
              {t('users.reauth.cancel')}
            </Button>
          ) : (
            <Button disabled={phase === 'mutating'} onClick={handleClose}>
              {t('users.modals.cancel')}
            </Button>
          )}
          <Button
            danger={danger}
            disabled={!canSubmit}
            loading={phase !== 'idle'}
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

export const openReasonModal = (props: ReasonModalContentProps): ModalInstance => {
  // Shared abort ref: onOpenChange(false) aborts before unmount/animation.
  const abortControllerRef: { current: AbortController | null } = { current: null };

  return createModal({
    content: <ReasonModalContent {...props} abortControllerRef={abortControllerRef} />,
    footer: null,
    maskClosable: false,
    title: null,
    width: 'min(92vw, 480px)',
    onOpenChange: (open) => {
      if (!open) {
        // Escape / dismiss / close — abort immediately, do not wait for unmount.
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
      }
    },
  });
};
