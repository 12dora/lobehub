'use client';

import { Text } from '@lobehub/ui';
import { Button, createModal, useModalContext } from '@lobehub/ui/base-ui';
import i18next from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SubscriptionCreate, SubscriptionView } from '@/types/platform/networkProxy';

import { networkProxyStyles as styles } from '../styles';
import {
  buildSubscriptionCreate,
  createSubscriptionFormState,
  nextSortOrder,
  type SubscriptionFormState,
  validateSubscriptionForm,
} from '../subscriptionForm';
import SubscriptionForm from './SubscriptionForm';

export interface CreateSubscriptionModalProps {
  existing: readonly SubscriptionView[];
  /** Resolves `true` once the subscription is stored; the modal stays open on failure. */
  onSubmit: (input: SubscriptionCreate) => Promise<boolean>;
}

const CreateSubscriptionContent = memo<CreateSubscriptionModalProps>(({ existing, onSubmit }) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const [state, setState] = useState<SubscriptionFormState>(() => createSubscriptionFormState());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const invalid = validateSubscriptionForm(state, 'create');
    if (invalid) {
      setError(t(`networkProxy.subscriptions.errors.${invalid}` as never));
      return;
    }
    setError(null);
    setBusy(true);
    const ok = await onSubmit(buildSubscriptionCreate(state, nextSortOrder(existing)));
    setBusy(false);
    if (ok) close();
    // Failures already surfaced by the shared mutation runner (toast + task state); keeping the
    // modal open preserves everything the admin typed, including the paste.
  };

  return (
    <div className={styles.stack}>
      <SubscriptionForm
        disabled={busy}
        mode="create"
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
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button disabled={busy} onClick={close}>
          {t('networkProxy.actions.cancel')}
        </Button>
        <Button loading={busy} type="primary" onClick={() => void submit()}>
          {t('networkProxy.subscriptions.create')}
        </Button>
      </div>
    </div>
  );
});

CreateSubscriptionContent.displayName = 'NetworkProxyCreateSubscriptionContent';

export const openCreateSubscriptionModal = (props: CreateSubscriptionModalProps) =>
  createModal({
    content: <CreateSubscriptionContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('networkProxy.subscriptions.create', { ns: 'admin' }),
    width: 'min(94vw, 720px)',
  });

export { CreateSubscriptionContent };
