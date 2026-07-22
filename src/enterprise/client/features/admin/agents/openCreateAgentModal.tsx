'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, createModal, toast, useModalContext } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import { getAdminAgentErrorMessage } from './errorPresentation';

/**
 * Stable, non-localized audit reason for create. Server still requires a non-empty reason;
 * locale-independent text keeps the audit trail consistent (mirrors delete).
 */
export const CREATE_AGENT_REASON = 'Platform assistant created from admin console';

interface CreateAgentContentProps {
  onCreated: (id: string) => Promise<void>;
}

export const CreateAgentContent = ({ onCreated }: CreateAgentContentProps) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  // UI labels this as "assistant name"; wire still sends `agentKey` to the backend contract.
  const [agentKey, setAgentKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await adminAgentsService.create({
        agentKey: agentKey.trim(),
        isDefault: false,
        reason: CREATE_AGENT_REASON,
        systemKey: null,
      });
      await onCreated(result.identity.id);
      toast.success(t('agentCatalog.toast.created'));
      close();
    } catch (cause) {
      setError(getAdminAgentErrorMessage(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flexbox gap={16}>
      <Flexbox gap={6}>
        <Text>{t('agentCatalog.create.key')}</Text>
        <Input
          aria-label={t('agentCatalog.create.key')}
          value={agentKey}
          onChange={(event) => setAgentKey(event.target.value)}
        />
      </Flexbox>
      {error ? <Text type="danger">{error}</Text> : null}
      <Flexbox horizontal justify="flex-end">
        <Button disabled={busy || !agentKey.trim()} type="primary" onClick={() => void submit()}>
          {busy ? t('agentCatalog.create.creating') : t('agentCatalog.create.submit')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
};

export const openCreateAgentModal = (onCreated: (id: string) => Promise<void>) =>
  createModal({
    content: <CreateAgentContent onCreated={onCreated} />,
    footer: null,
    maskClosable: false,
    title: t('agentCatalog.create.submit', { ns: 'admin' }),
    width: 520,
  });
