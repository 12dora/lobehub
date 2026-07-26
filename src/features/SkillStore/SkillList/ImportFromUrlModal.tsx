'use client';

import { Alert, Flexbox, Icon, Input } from '@lobehub/ui';
import { Button, createModal, type ModalInstance, useModalContext } from '@lobehub/ui/base-ui';
import { App, Typography } from 'antd';
import { ArrowLeftRight, Link, Sparkles } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import { useToolStore } from '@/store/tool';

import { resolveSkillImportCapability, runSkillImport } from '../skillStorePolicy';

export interface ImportFromUrlModalOptions {
  /** Resolved platform capability when an admin persistence override is active. */
  canCreate?: boolean;
  /** Persistence override (admin org catalog); default imports into the user's skills. */
  onImport?: (input: { url: string }) => Promise<void>;
}

const ImportFromUrlContent = memo<ImportFromUrlModalOptions>(({ canCreate, onImport }) => {
  const { t } = useTranslation(['setting', 'common']);
  const { close, setCanDismissByClickOutside } = useModalContext();
  const { message } = App.useApp();
  const importAgentSkillFromUrl = useToolStore((s) => s.importAgentSkillFromUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const { allowed: canCreatePersonalSkill } = usePermission('create_content');
  const resolvedCanCreate = resolveSkillImportCapability(
    Boolean(onImport),
    canCreate,
    canCreatePersonalSkill,
  );

  useEffect(() => {
    setCanDismissByClickOutside(!loading);
  }, [loading, setCanDismissByClickOutside]);

  const handleImport = async () => {
    const trimmed = url.trim();
    if (!resolvedCanCreate || !trimmed) return;

    setLoading(true);
    setError(null);

    try {
      await runSkillImport({
        importSkill: () => (onImport ?? importAgentSkillFromUrl)({ url: trimmed }),
        onComplete: close,
        onPersonalSuccess: () => message.success(t('agentSkillModal.importSuccess')),
        platformOverride: Boolean(onImport),
      });
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Flexbox gap={16}>
      <Flexbox align="center" gap={16} padding={'16px 0'}>
        <Flexbox horizontal align="center" gap={8}>
          <Icon icon={Link} size={28} />
          <Icon
            icon={ArrowLeftRight}
            size={16}
            style={{ color: 'var(--ant-color-text-tertiary)' }}
          />
          <Icon icon={Sparkles} size={28} />
        </Flexbox>

        <Flexbox align="center" gap={4}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('agentSkillModal.url.title')}
          </Typography.Title>
          <Typography.Text type="secondary">{t('agentSkillModal.url.desc')}</Typography.Text>
        </Flexbox>
      </Flexbox>

      {error && <Alert showIcon title={t('agentSkillModal.importError', { error })} type="error" />}

      <Flexbox gap={8}>
        <Typography.Text strong>URL</Typography.Text>
        <Input
          disabled={!resolvedCanCreate}
          placeholder={t('agentSkillModal.url.urlPlaceholder')}
          value={url}
          onPressEnter={handleImport}
          onChange={(e) => {
            setUrl(e.target.value);
            if (error) setError(null);
          }}
        />
      </Flexbox>

      <Button
        block
        disabled={!resolvedCanCreate}
        loading={loading}
        type="primary"
        onClick={handleImport}
      >
        {t('common:import')}
      </Button>
    </Flexbox>
  );
});

ImportFromUrlContent.displayName = 'ImportFromUrlContent';

export const openImportFromUrlModal = (options?: ImportFromUrlModalOptions): ModalInstance =>
  createModal({
    content: <ImportFromUrlContent canCreate={options?.canCreate} onImport={options?.onImport} />,
    footer: null,
    maskClosable: true,
    styles: { header: { display: 'none' } },
    width: 480,
  });
