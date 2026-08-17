'use client';

import { Text } from '@lobehub/ui';
import { Button, Input, InputNumber, InputPassword, Select } from '@lobehub/ui/base-ui';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_STATIC_PROXY_TYPES } from '@/const/platform/networkProxy';
import type {
  NetworkProxyStaticProxyType,
  StaticProxyUpdate,
  StaticProxyView,
} from '@/types/platform/networkProxy';

import { Field } from '../Section';
import { networkProxyStyles as styles } from '../styles';

export interface StaticProxyFormProps {
  busy: boolean;
  disabled: boolean;
  onRemove: () => void;
  onSubmit: (value: StaticProxyUpdate) => void;
  /**
   * The submission the admin is still waiting on (in flight, failed or conflicted).
   * `undefined` means there is none. While it is set the form must NOT be reseeded from the
   * server view: after losing a CAS race the winner's proxy would otherwise replace what the
   * admin typed, while Retry silently re-sent the original values.
   */
  pendingDraft?: StaticProxyUpdate | null;
  value?: StaticProxyView;
}

type PasswordAction = 'clear' | 'keep' | 'replace';

interface FormState {
  password: string;
  passwordAction: PasswordAction;
  port: number;
  server: string;
  type: NetworkProxyStaticProxyType;
  username: string;
}

const toFormState = (value?: StaticProxyView): FormState => ({
  password: '',
  passwordAction: 'keep',
  port: value?.port ?? 7890,
  server: value?.server ?? '',
  type: value?.type ?? 'http',
  username: value?.username ?? '',
});

/**
 * Seed from the submission the admin is still waiting on. Used on mount, so a form that was
 * unmounted by a conflicting write (the winner switched the outlet back to the engine) comes back
 * showing exactly what Retry would send — never the winner's proxy.
 */
const fromPendingDraft = (draft: StaticProxyUpdate): FormState => ({
  password: draft.password.action === 'replace' ? draft.password.value : '',
  passwordAction: draft.password.action,
  port: draft.port,
  server: draft.server,
  type: draft.type,
  username: draft.username ?? '',
});

/**
 * 静态上游代理 (design §4.1 / §6.2). Unlike the rest of the tab this sub-form saves as one unit:
 * host, port and credentials are a single working configuration, and writing them field by field
 * would leave the platform pointed at a half-configured outlet between keystrokes.
 *
 * The password is never returned by the server, so the intent is explicit — keep what is stored,
 * replace it, or clear it (design §5).
 */
const StaticProxyForm = memo<StaticProxyFormProps>(
  ({ busy, disabled, onRemove, onSubmit, pendingDraft, value }) => {
    const { t } = useTranslation('admin');
    const [state, setState] = useState<FormState>(() =>
      pendingDraft ? fromPendingDraft(pendingDraft) : toFormState(value),
    );

    // Re-seed only when the *stored* proxy actually changed (another admin saved, or a conflict
    // reload landed) — never on a plain re-render, which would wipe what is being typed.
    const signature = value
      ? `${value.type}|${value.server}|${value.port}|${value.username ?? ''}|${value.hasPassword}`
      : 'none';
    const hasPendingDraft = pendingDraft !== undefined;
    const seededRef = useRef(signature);
    const wasPendingRef = useRef(hasPendingDraft);
    useEffect(() => {
      // What is on screen is what Retry will submit — keep them the same.
      if (hasPendingDraft) {
        wasPendingRef.current = true;
        return;
      }
      // Pending → resolved or dismissed: always re-seed, even when the public signature did not
      // change. A password-only submission leaves server type/host/port/username identical, so a
      // signature check alone would keep the rejected replacement password in the field.
      if (wasPendingRef.current) {
        wasPendingRef.current = false;
        seededRef.current = signature;
        setState(toFormState(value));
        return;
      }
      if (seededRef.current === signature) return;
      seededRef.current = signature;
      setState(toFormState(value));
    }, [hasPendingDraft, signature, value]);

    const patch = (next: Partial<FormState>) => setState((current) => ({ ...current, ...next }));
    const invalid = state.server.trim().length === 0 || state.port < 1 || state.port > 65_535;

    const submit = () => {
      if (invalid) return;
      const password: StaticProxyUpdate['password'] =
        state.passwordAction === 'replace'
          ? { action: 'replace', value: state.password }
          : { action: state.passwordAction };
      onSubmit({
        password,
        port: state.port,
        server: state.server.trim(),
        type: state.type,
        ...(state.username.trim() ? { username: state.username.trim() } : {}),
      });
    };

    return (
      <div className={styles.stack}>
        <div className={styles.fieldGrid}>
          <Field label={t('networkProxy.outlet.staticType')}>
            <Select
              disabled={disabled}
              value={state.type}
              options={NETWORK_PROXY_STATIC_PROXY_TYPES.map((type) => ({
                label: type,
                value: type,
              }))}
              onChange={(next) => patch({ type: next as NetworkProxyStaticProxyType })}
            />
          </Field>
          <Field label={t('networkProxy.outlet.staticServer')}>
            <Input
              disabled={disabled}
              placeholder={t('networkProxy.outlet.staticServerPlaceholder')}
              value={state.server}
              onChange={(event) => patch({ server: event.target.value })}
            />
          </Field>
          <Field label={t('networkProxy.outlet.staticPort')}>
            <InputNumber
              disabled={disabled}
              max={65_535}
              min={1}
              value={state.port}
              onChange={(next) => patch({ port: Number(next ?? 0) })}
            />
          </Field>
          <Field label={t('networkProxy.outlet.staticUsername')}>
            <Input
              disabled={disabled}
              value={state.username}
              onChange={(event) => patch({ username: event.target.value })}
            />
          </Field>
        </div>

        <Field
          hint={t('networkProxy.outlet.staticPasswordHint')}
          label={t('networkProxy.outlet.staticPassword')}
        >
          {value?.hasPassword ? (
            <div className={styles.inlineActions}>
              <Select
                disabled={disabled}
                style={{ width: 180 }}
                value={state.passwordAction}
                options={[
                  { label: t('networkProxy.outlet.passwordKeep'), value: 'keep' },
                  { label: t('networkProxy.outlet.passwordReplace'), value: 'replace' },
                  { label: t('networkProxy.outlet.passwordClear'), value: 'clear' },
                ]}
                onChange={(next) => patch({ password: '', passwordAction: next as PasswordAction })}
              />
              {state.passwordAction === 'replace' ? (
                <InputPassword
                  autoComplete="new-password"
                  disabled={disabled}
                  style={{ maxWidth: 280 }}
                  value={state.password}
                  onChange={(event) => patch({ password: event.target.value })}
                />
              ) : null}
            </div>
          ) : (
            <InputPassword
              autoComplete="new-password"
              disabled={disabled}
              style={{ maxWidth: 280 }}
              value={state.password}
              onChange={(event) =>
                patch({
                  password: event.target.value,
                  passwordAction: event.target.value ? 'replace' : 'keep',
                })
              }
            />
          )}
        </Field>

        <div className={styles.inlineActions}>
          <Button
            disabled={disabled || invalid}
            loading={busy}
            size="small"
            type="primary"
            onClick={submit}
          >
            {t('networkProxy.outlet.saveStatic')}
          </Button>
          {value ? (
            <Button danger disabled={disabled} size="small" onClick={onRemove}>
              {t('networkProxy.outlet.removeStatic')}
            </Button>
          ) : null}
          {invalid ? (
            <Text style={{ fontSize: 12 }} type="secondary">
              {t('networkProxy.outlet.staticIncomplete')}
            </Text>
          ) : null}
        </div>
      </div>
    );
  },
);

StaticProxyForm.displayName = 'NetworkProxyStaticProxyForm';

export default StaticProxyForm;
