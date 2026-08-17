'use client';

import { Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Drawer } from 'antd';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  SubscriptionIssue,
  SubscriptionUpdate,
  SubscriptionView,
} from '@/types/platform/networkProxy';

import { isInformationalSubscriptionIssue, networkProxySubscriptionIssueKey } from '../errors';
import { formatDateTime } from '../format';
import { networkProxyStyles as styles } from '../styles';
import {
  buildSubscriptionUpdate,
  createSubscriptionFormState,
  type SubscriptionFormState,
  validateSubscriptionForm,
} from '../subscriptionForm';
import SubscriptionForm from './SubscriptionForm';

export interface SubscriptionEditDrawerProps {
  canManage: boolean;
  onClose: () => void;
  onSubmit: (input: SubscriptionUpdate) => Promise<boolean>;
  subscription: SubscriptionView | null;
}

const SubscriptionIssueAlert = memo<{ issue: SubscriptionIssue }>(({ issue }) => {
  const { t } = useTranslation('admin');
  const informational = isInformationalSubscriptionIssue(issue.code);
  const label = (
    <Text
      className={informational ? styles.hintText : undefined}
      role={informational ? 'status' : 'alert'}
      type={informational ? undefined : 'danger'}
    >
      {t(networkProxySubscriptionIssueKey(issue.code) as never, { detail: issue.detail ?? '' })}
    </Text>
  );
  return issue.detail ? <Tooltip title={issue.detail}>{label}</Tooltip> : label;
});

/** 编辑订阅 (design §6.3). The stored URL / paste is never returned — blank means "keep". */
const SubscriptionEditDrawer = memo<SubscriptionEditDrawerProps>(
  ({ canManage, onClose, onSubmit, subscription }) => {
    const { t } = useTranslation('admin');
    const [state, setState] = useState<SubscriptionFormState>(() =>
      createSubscriptionFormState(subscription ?? undefined),
    );
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // Re-seed on a different row or a newer server version only — not on every re-render.
    const signature = subscription ? `${subscription.id}|${subscription.updatedAt}` : 'none';
    const seededRef = useRef(signature);
    useEffect(() => {
      if (seededRef.current === signature) return;
      seededRef.current = signature;
      setState(createSubscriptionFormState(subscription ?? undefined));
      setError(null);
    }, [signature, subscription]);

    const submit = async () => {
      if (!subscription) return;
      const invalid = validateSubscriptionForm(state, 'edit');
      if (invalid) {
        setError(t(`networkProxy.subscriptions.errors.${invalid}` as never));
        return;
      }
      setError(null);
      setBusy(true);
      const ok = await onSubmit(buildSubscriptionUpdate(subscription, state));
      setBusy(false);
      if (ok) onClose();
    };

    return (
      <Drawer
        destroyOnClose
        open={Boolean(subscription)}
        title={t('networkProxy.subscriptions.edit')}
        width={620}
        extra={
          <Button
            disabled={!canManage || busy}
            loading={busy}
            type="primary"
            onClick={() => void submit()}
          >
            {t('networkProxy.actions.save')}
          </Button>
        }
        onClose={onClose}
      >
        {subscription ? (
          <div className={styles.stack}>
            <Text className={styles.hintText}>
              {t('networkProxy.subscriptions.lastUpdateLine', {
                time: formatDateTime(subscription.lastUpdateAt),
              })}
            </Text>
            {subscription.lastIssue ? (
              <SubscriptionIssueAlert issue={subscription.lastIssue} />
            ) : null}
            <SubscriptionForm
              disabled={!canManage || busy}
              mode="edit"
              state={state}
              onChange={(patch) => {
                setState((current) => ({ ...current, ...patch }));
                setError(null);
              }}
            />
            {error ? (
              <Text role="alert" type="danger">
                {error}
              </Text>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    );
  },
);

SubscriptionEditDrawer.displayName = 'NetworkProxySubscriptionEditDrawer';

export default SubscriptionEditDrawer;
