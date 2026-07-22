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
import { cloneFromCanonical, createCanonicalSnapshot } from './payloadSnapshot';

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
    const [errorKey, setErrorKey] = useState<string | null>(null);
    /** Private canonical snapshot — never passed to onSubmit. */
    const canonicalRef = useRef<unknown>(null);
    const localAbortRef = useRef<AbortController | null>(null);
    const abortRef = abortControllerRef ?? localAbortRef;
    const mountedRef = useRef(true);

    const setPhaseBoth = useCallback(
      (next: ReasonModalPhase) => {
        if (!mountedRef.current) return;
        setPhase(next);
        onPhaseChange?.(next);
      },
      [onPhaseChange],
    );

    const setErrorKeySafe = useCallback((key: string | null) => {
      if (!mountedRef.current) return;
      setErrorKey(key);
    }, []);

    const abortActive = useCallback(() => {
      abortRef.current?.abort();
      abortRef.current = null;
    }, [abortRef]);

    // Complements onOpenChange(false) / Cancel: unmount must still abort + clear snapshot.
    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        abortRef.current?.abort();
        abortRef.current = null;
        canonicalRef.current = null;
      };
    }, [abortRef]);

    const locked = phase !== 'idle';
    const canSubmit = (hideReason || reason.trim().length > 0) && phase === 'idle';

    const handleClose = useCallback(() => {
      // Immediate abort — Escape/close must not wait for unmount cleanup.
      abortActive();
      canonicalRef.current = null;
      close();
    }, [abortActive, close]);

    const handleCancelReauth = useCallback(() => {
      // Only reauth is abortable; do not pretend an in-flight server mutation cancels.
      if (phase !== 'reauthing') return;
      abortActive();
      setPhaseBoth('idle');
      setErrorKeySafe('users.errors.reauthCancelled');
    }, [abortActive, phase, setErrorKeySafe, setPhaseBoth]);

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

      // Build live payload once, then store a private structured-cloned freeze.
      const built = buildPayload(trimmed);
      canonicalRef.current = createCanonicalSnapshot(built);

      setErrorKeySafe(null);
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        await withAdminReauthRetry(
          async () => {
            setPhaseBoth('mutating');
            const canonical = canonicalRef.current;
            if (canonical === null || ac.signal.aborted || !mountedRef.current) {
              throw new AdminReauthCancelledError();
            }
            // Fresh clone per attempt — first call mutation cannot poison retry.
            const attemptPayload = cloneFromCanonical(canonical);
            await onSubmit(attemptPayload);
          },
          {
            authMethod: authMethod ?? null,
            signal: ac.signal,
            onReauthStart: () => {
              setPhaseBoth('reauthing');
            },
          },
        );
        if (!mountedRef.current) return;
        canonicalRef.current = null;
        close();
      } catch (error) {
        if (!mountedRef.current) return;
        if (error instanceof AdminReauthCancelledError) {
          setErrorKeySafe('users.errors.reauthCancelled');
        } else if (error instanceof AdminReauthBlockedError) {
          setErrorKeySafe('users.errors.reauthBlocked');
        } else {
          const mapped = mapEnterpriseError(error);
          if (mapped?.action === 'reauth') {
            setErrorKeySafe('users.errors.reauthRequired');
          } else {
            setErrorKeySafe(getAdminUsersMutationErrorKey(error));
          }
        }
        setPhaseBoth('idle');
      } finally {
        if (abortRef.current === ac) {
          abortRef.current = null;
        }
        if (mountedRef.current) {
          setPhase((p) => (p === 'mutating' || p === 'reauthing' ? 'idle' : p));
        }
      }
    }, [
      abortRef,
      authMethod,
      autoReason,
      buildPayload,
      close,
      hideReason,
      onSubmit,
      phase,
      reason,
      setErrorKeySafe,
      setPhaseBoth,
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
