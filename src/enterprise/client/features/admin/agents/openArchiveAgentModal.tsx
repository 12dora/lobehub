'use client';

import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, createModal, Select, useModalContext } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ArchiveCandidate {
  label: string;
  value: string;
}

interface ArchiveAgentContentProps {
  candidates: ArchiveCandidate[];
  isDefault: boolean;
  onConfirm: (reason: string, replacementAgentId: string | null) => Promise<void>;
}

const ArchiveAgentContent = ({ candidates, isDefault, onConfirm }: ArchiveAgentContentProps) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const [reason, setReason] = useState('');
  const [replacementAgentId, setReplacementAgentId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm(reason.trim(), replacementAgentId ?? null);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flexbox gap={16}>
      <Text>{t('agentCatalog.archive.description')}</Text>
      {isDefault ? (
        <Flexbox gap={6}>
          <Text>{t('agentCatalog.archive.replacement')}</Text>
          <Select
            aria-label={t('agentCatalog.archive.replacement')}
            options={candidates}
            placeholder={t('agentCatalog.archive.replacementPlaceholder')}
            value={replacementAgentId}
            onChange={(value) => setReplacementAgentId(value as string)}
          />
          {candidates.length === 0 ? (
            <Text type="danger">{t('agentCatalog.archive.noReplacement')}</Text>
          ) : null}
        </Flexbox>
      ) : null}
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
          danger
          disabled={busy || !reason.trim() || (isDefault && !replacementAgentId)}
          onClick={() => void submit()}
        >
          {busy ? t('agentCatalog.action.running') : t('agentCatalog.archive.submit')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
};

export const openArchiveAgentModal = (options: ArchiveAgentContentProps) =>
  createModal({
    content: <ArchiveAgentContent {...options} />,
    footer: null,
    maskClosable: false,
    title: t('agentCatalog.archive.title', { ns: 'admin' }),
    width: 520,
  });
