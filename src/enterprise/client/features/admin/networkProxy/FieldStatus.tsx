'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { networkProxyStyles as styles } from './styles';
import type { NetworkProxyActions } from './useNetworkProxyActions';

export interface FieldStatusProps {
  actions: NetworkProxyActions;
  /** Field id from `NETWORK_PROXY_FIELDS`. */
  field: string;
  /** Copy for the in-flight line. Omit to stay silent while a quick toggle saves. */
  pendingLabel?: string;
  /** Copy for the success line. Omit for controls whose new value is its own confirmation. */
  successLabel?: string;
}

/**
 * The outcome of one instant save, rendered next to the control it belongs to.
 *
 * A failed or conflicted write keeps the admin's value on screen; this is where they learn why
 * it has not landed and choose to retry or drop it. Nothing here is a toast — a long task's
 * failure must still be visible after the admin looks away (design §6).
 */
const FieldStatus = memo<FieldStatusProps>(({ actions, field, pendingLabel, successLabel }) => {
  const { t } = useTranslation('admin');
  const entry = actions.entryOf(field);
  if (!entry) return null;

  if (entry.status === 'pending') {
    return pendingLabel ? <span className={styles.hintText}>{pendingLabel}</span> : null;
  }

  if (entry.status === 'success') {
    return successLabel ? (
      <Text style={{ fontSize: 12 }} type="success">
        {successLabel}
      </Text>
    ) : null;
  }

  const conflict = entry.status === 'conflict';
  return (
    <div className={styles.inlineActions} role="alert">
      <Text style={{ fontSize: 12 }} type={conflict ? 'warning' : 'danger'}>
        {/* Prefer the server's own (already redacted) reason — it names the real cause;
            `errorKey` is the fallback when the failure has no message of its own. */}
        {entry.errorText ?? t((entry.errorKey ?? 'networkProxy.errors.generic') as never)}
      </Text>
      {entry.retry ? (
        <Button size="small" onClick={() => void actions.retry(field)}>
          {t('networkProxy.actions.retry')}
        </Button>
      ) : null}
      <Button size="small" onClick={() => actions.dismiss(field)}>
        {t(conflict ? 'networkProxy.conflict.dismiss' : 'networkProxy.actions.dismiss')}
      </Button>
    </div>
  );
});

FieldStatus.displayName = 'NetworkProxyFieldStatus';

export default FieldStatus;
