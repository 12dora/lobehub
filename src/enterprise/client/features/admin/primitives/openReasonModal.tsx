'use client';

import { Text, TextArea } from '@lobehub/ui';
import { Button, createModal, type ModalInstance, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { getAdminUsersMutationErrorKey } from '@/enterprise/client/features/admin/users/utils';

import { useModalPhaseGuard } from './useModalPhaseGuard';
import { type AdminReauthBusyPhase, useReauthMutation } from './useReauthMutation';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 12px;
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

/** Live phase + explicit-close flag shared with openReasonModal's onOpenChange. */
export type ReasonModalDismissGuard = {
  closedExplicitly: boolean;
  phase: ReasonModalPhase;
};

export interface ReasonModalContentProps {
  /**
   * Shared abort controller for this modal instance.
   * openReasonModal wires onOpenChange(false) to abort immediately (Escape/close).
   */
  abortControllerRef?: React.MutableRefObject<AbortController | null>;
  authMethod?: AdminReauthAuthMethod;
  /**
   * Fixed reason recorded in the audit trail when the operator does not type one.
   * Required (non-empty) whenever `hideReason` or `optionalReason` is true — the server
   * contract still bounds the field to a non-empty string.
   */
  autoReason?: string;
  buildPayload: (reason: string) => unknown;
  danger?: boolean;
  description?: string;
  /** Live phase for Escape/dismiss veto while a mutation is in flight. */
  dismissGuardRef?: React.MutableRefObject<ReasonModalDismissGuard>;
  extra?:
    | ReactNode
    | ((api: {
        locked: boolean;
        phase: ReasonModalPhase;
        /** Call when extra fields change so submit eligibility re-evaluates. */
        reportExtraChange: () => void;
      }) => ReactNode);
  /** Confirm-only mode: hide the reason textarea and submit `autoReason` instead. */
  hideReason?: boolean;
  impact?: string;
  /** Called when phase changes (tests / parent). */
  onPhaseChange?: (phase: ReasonModalPhase) => void;
  onSubmit: (payload: unknown) => Promise<void>;
  /**
   * Optional-reason mode: the textarea stays (the prose is still read back later, e.g.
   * `user.banReason`) but submitting empty is allowed and falls back to `autoReason`.
   * Ignored when `hideReason` is set.
   */
  optionalReason?: boolean;
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
    optionalReason,
    submitLabel,
    targetLabel,
    title,
    validateExtra,
    abortControllerRef,
    dismissGuardRef,
    onPhaseChange,
  }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [reason, setReason] = useState('');
    // Bumps when extra fields change so validateExtra is re-read for button eligibility.
    const [extraEpoch, setExtraEpoch] = useState(0);
    const reportExtraChange = useCallback(() => {
      setExtraEpoch((n) => n + 1);
    }, []);

    // base-ui still dismisses on Escape despite maskClosable: false — block capture
    // while the server mutation is in flight so progress/error state is not lost.
    const { phase, setPhase: syncPhase } = useModalPhaseGuard<ReasonModalPhase>({
      blockEscapeWhen: ['mutating'],
      dismissGuardRef,
      initialPhase: 'idle',
      onPhaseChange,
    });

    const resetBusyPhase = useCallback(() => {
      syncPhase('idle');
    }, [syncPhase]);

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
        syncPhase(next);
      },
    });

    const locked = phase !== 'idle';
    // Include validateExtra in eligibility so type-to-confirm / expiry stay gated until valid.
    // extraEpoch forces re-evaluation when nested extra fields notify of changes.
    void extraEpoch;
    const extraValid = !validateExtra || validateExtra() === null;
    // A typed reason is only a gate when it is the sole record of intent: hidden and optional
    // modes both resolve to `autoReason`, so neither may block the confirm button.
    const reasonSatisfied = hideReason || optionalReason || reason.trim().length > 0;
    const canSubmit = reasonSatisfied && phase === 'idle' && extraValid;

    const handleClose = useCallback(() => {
      // Explicit close — mark so onOpenChange does not re-open during exit animation.
      if (dismissGuardRef) dismissGuardRef.current.closedExplicitly = true;
      // Immediate abort — Escape/close must not wait for unmount cleanup.
      abortActive();
      clearCanonical();
      close();
    }, [abortActive, clearCanonical, close, dismissGuardRef]);

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
      // Hidden mode never reads the textarea; optional mode prefers what was typed and falls
      // back to the stable code so the server's non-empty contract still holds.
      const typed = reason.trim();
      const fallback = (autoReason ?? '').trim();
      const trimmed = hideReason ? fallback : typed || (optionalReason ? fallback : '');
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
          // Explicit success close — do not treat as Escape (would re-open while phase
          // is still mutating until finally demotes it).
          if (dismissGuardRef) dismissGuardRef.current.closedExplicitly = true;
          close();
        },
      });
    }, [
      authMethod,
      autoReason,
      buildPayload,
      close,
      dismissGuardRef,
      hideReason,
      mapReasonModalError,
      onSubmit,
      optionalReason,
      phase,
      reason,
      runReauthedSubmit,
      setErrorKeySafe,
      validateExtra,
    ]);

    const extraNode =
      typeof extra === 'function' ? extra({ locked, phase, reportExtraChange }) : extra;

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
            <Text>
              {optionalReason ? t('users.actions.reasonOptional') : t('users.modals.reasonLabel')}
            </Text>
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
  const dismissGuardRef: { current: ReasonModalDismissGuard } = {
    current: { closedExplicitly: false, phase: 'idle' },
  };

  const instance = createModal({
    content: (
      <ReasonModalContent
        {...props}
        abortControllerRef={abortControllerRef}
        dismissGuardRef={dismissGuardRef}
      />
    ),
    footer: null,
    maskClosable: false,
    title: null,
    width: 'min(92vw, 480px)',
    onOpenChange: (open) => {
      if (open) return;
      const { closedExplicitly, phase } = dismissGuardRef.current;
      // base-ui commits Escape close before this callback. While mutating, veto by
      // re-opening so the admin does not lose progress/error state for a still-running
      // request (tRPC has no abort signal here).
      if (!closedExplicitly && phase === 'mutating') {
        instance.update({ open: true });
        return;
      }
      // Escape / dismiss / close — abort immediately, do not wait for unmount.
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    },
  });

  return instance;
};
