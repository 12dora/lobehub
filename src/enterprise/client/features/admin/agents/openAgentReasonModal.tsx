'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, createModal, useModalContext } from '@lobehub/ui/base-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ReasonContentProps {
  danger?: boolean;
  description: string;
  onConfirm: (reason: string) => Promise<void>;
  submitLabel: string;
}

const ReasonContent = ({ danger, description, onConfirm, submitLabel }: ReasonContentProps) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flexbox gap={16}>
      <Text type="secondary">{description}</Text>
      <Flexbox gap={6}>
        <Text>{t('agentCatalog.reason.label')}</Text>
        <Input
          aria-label={t('agentCatalog.reason.label')}
          placeholder={t('agentCatalog.reason.placeholder')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Flexbox>
      {error ? <Text type="danger">{error}</Text> : null}
      <Flexbox horizontal justify="flex-end">
        <Button
          danger={danger}
          disabled={busy || !reason.trim()}
          type={danger ? 'default' : 'primary'}
          onClick={() => void submit()}
        >
          {busy ? t('agentCatalog.action.running') : submitLabel}
        </Button>
      </Flexbox>
    </Flexbox>
  );
};

interface OpenAgentReasonModalOptions extends ReasonContentProps {
  title: string;
}

export const openAgentReasonModal = ({ title, ...props }: OpenAgentReasonModalOptions) =>
  createModal({
    content: <ReasonContent {...props} />,
    footer: null,
    maskClosable: false,
    title,
    width: 520,
  });
