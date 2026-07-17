'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, createModal, toast, useModalContext } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

interface CreateAgentContentProps {
  onCreated: (id: string) => Promise<void>;
}

const CreateAgentContent = ({ onCreated }: CreateAgentContentProps) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const [agentKey, setAgentKey] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await adminAgentsService.create({
        agentKey,
        isDefault: false,
        reason,
        systemKey: null,
      });
      await onCreated(result.identity.id);
      toast.success(t('agentCatalog.toast.created'));
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flexbox gap={16}>
      <Flexbox gap={6}>
        <Text>{t('agentCatalog.create.key')}</Text>
        <Input value={agentKey} onChange={(event) => setAgentKey(event.target.value)} />
      </Flexbox>
      <Flexbox gap={6}>
        <Text>{t('agentCatalog.create.reason')}</Text>
        <Input value={reason} onChange={(event) => setReason(event.target.value)} />
      </Flexbox>
      {error ? <Text type="danger">{error}</Text> : null}
      <Flexbox horizontal justify="flex-end">
        <Button
          disabled={busy || !agentKey.trim() || !reason.trim()}
          type="primary"
          onClick={() => void submit()}
        >
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
