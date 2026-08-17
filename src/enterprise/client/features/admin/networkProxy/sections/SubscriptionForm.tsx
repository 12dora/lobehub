'use client';

import { Text } from '@lobehub/ui';
import { Input, InputNumber, Segmented, Switch, TextArea } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { NETWORK_PROXY_LIMITS } from '@/const/platform/networkProxy';

import { Field } from '../Section';
import { networkProxyStyles as styles } from '../styles';
import type { SubscriptionFormState } from '../subscriptionForm';

export interface SubscriptionFormProps {
  disabled: boolean;
  mode: 'create' | 'edit';
  onChange: (patch: Partial<SubscriptionFormState>) => void;
  state: SubscriptionFormState;
}

/**
 * One form for both 新增订阅 and 编辑订阅 (design §6.3).
 *
 * The kind is fixed after creation: a URL subscription and a pasted node list are stored in
 * different encrypted columns, so switching would silently discard one of them.
 */
const SubscriptionForm = memo<SubscriptionFormProps>(({ disabled, mode, onChange, state }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.stack}>
      <Field label={t('networkProxy.subscriptions.form.name')}>
        <Input
          disabled={disabled}
          maxLength={NETWORK_PROXY_LIMITS.SUBSCRIPTION_NAME_MAX_CHARS}
          placeholder={t('networkProxy.subscriptions.form.namePlaceholder')}
          value={state.name}
          onChange={(event) => onChange({ name: event.target.value })}
        />
      </Field>

      {mode === 'create' ? (
        <Field
          hint={t('networkProxy.subscriptions.form.kindHint')}
          label={t('networkProxy.subscriptions.form.kind')}
        >
          <Segmented
            disabled={disabled}
            value={state.kind}
            options={[
              { label: t('networkProxy.subscriptionKind.url'), value: 'url' },
              { label: t('networkProxy.subscriptionKind.manual'), value: 'manual' },
            ]}
            onChange={(next) => onChange({ kind: next as 'manual' | 'url' })}
          />
        </Field>
      ) : null}

      {state.kind === 'url' ? (
        <>
          <Field
            label={t('networkProxy.subscriptions.form.url')}
            hint={
              mode === 'edit'
                ? t('networkProxy.subscriptions.form.urlKeepHint')
                : t('networkProxy.subscriptions.form.urlHint')
            }
          >
            <Input
              autoComplete="off"
              disabled={disabled}
              placeholder={t('networkProxy.subscriptions.form.urlPlaceholder')}
              value={state.url}
              onChange={(event) => onChange({ url: event.target.value })}
            />
          </Field>
          <div className={styles.fieldGrid}>
            <Field
              hint={t('networkProxy.subscriptions.form.intervalHint')}
              label={t('networkProxy.subscriptions.form.interval')}
            >
              <InputNumber
                disabled={disabled}
                max={NETWORK_PROXY_LIMITS.SUBSCRIPTION_UPDATE_INTERVAL_MAX_SEC}
                min={NETWORK_PROXY_LIMITS.SUBSCRIPTION_UPDATE_INTERVAL_MIN_SEC}
                value={state.updateIntervalSec}
                onChange={(next) => onChange({ updateIntervalSec: Number(next ?? 0) })}
              />
            </Field>
            <Field
              hint={t('networkProxy.subscriptions.form.userAgentHint')}
              label={t('networkProxy.subscriptions.form.userAgent')}
            >
              <Input
                disabled={disabled}
                placeholder={t('networkProxy.subscriptions.form.userAgentPlaceholder')}
                value={state.userAgent}
                onChange={(event) => onChange({ userAgent: event.target.value })}
              />
            </Field>
          </div>
        </>
      ) : (
        <Field
          label={t('networkProxy.subscriptions.form.payload')}
          hint={
            mode === 'edit'
              ? t('networkProxy.subscriptions.form.payloadKeepHint')
              : t('networkProxy.subscriptions.form.payloadHint')
          }
        >
          <TextArea
            disabled={disabled}
            placeholder={t('networkProxy.subscriptions.form.payloadPlaceholder')}
            rows={6}
            value={state.payload}
            onChange={(event) => onChange({ payload: event.target.value })}
          />
        </Field>
      )}

      <div className={styles.fieldGrid}>
        <Field
          hint={t('networkProxy.subscriptions.form.filterHint')}
          label={t('networkProxy.subscriptions.form.filter')}
        >
          <Input
            disabled={disabled}
            value={state.filter}
            onChange={(event) => onChange({ filter: event.target.value })}
          />
        </Field>
        <Field label={t('networkProxy.subscriptions.form.excludeFilter')}>
          <Input
            disabled={disabled}
            value={state.excludeFilter}
            onChange={(event) => onChange({ excludeFilter: event.target.value })}
          />
        </Field>
      </div>

      <div className={styles.toolbarRow}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <Text strong style={{ fontSize: 13 }}>
            {t('networkProxy.subscriptions.form.enabled')}
          </Text>
          <span className={styles.hintText}>
            {t('networkProxy.subscriptions.form.enabledHint')}
          </span>
        </div>
        <Switch
          checked={state.enabled}
          disabled={disabled}
          onChange={(checked) => onChange({ enabled: Boolean(checked) })}
        />
      </div>
    </div>
  );
});

SubscriptionForm.displayName = 'NetworkProxySubscriptionForm';

export default SubscriptionForm;
