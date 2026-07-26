'use client';

import { Alert, Flexbox, Icon, Input } from '@lobehub/ui';
import { Button, createModal, type ModalInstance, useModalContext } from '@lobehub/ui/base-ui';
import { GithubIcon } from '@lobehub/ui/icons';
import { App, Typography } from 'antd';
import { ArrowLeftRight, Sparkles } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import { useToolStore } from '@/store/tool';

import { resolveSkillImportCapability, runSkillImport } from '../skillStorePolicy';

export interface ImportFromGithubModalOptions {
  /** Resolved platform capability when an admin persistence override is active. */
  canCreate?: boolean;
  /** Persistence override (admin org catalog); default imports into the user's skills. */
  onImport?: (input: { gitUrl: string }) => Promise<void>;
}

const ImportFromGithubContent = memo<ImportFromGithubModalOptions>(({ canCreate, onImport }) => {
  const { t } = useTranslation(['setting', 'common']);
  const { close, setCanDismissByClickOutside } = useModalContext();
  const { message } = App.useApp();
  const importAgentSkillFromGitHub = useToolStore((s) => s.importAgentSkillFromGitHub);
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
        importSkill: async () => {
          await (onImport ?? importAgentSkillFromGitHub)({ gitUrl: trimmed });
        },
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
          <Icon icon={GithubIcon} size={28} />
          <Icon
            icon={ArrowLeftRight}
            size={16}
            style={{ color: 'var(--ant-color-text-tertiary)' }}
          />
          <Icon icon={Sparkles} size={28} />
        </Flexbox>

        <Flexbox align="center" gap={4}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {t('agentSkillModal.github.title')}
          </Typography.Title>
          <Typography.Text style={{ textAlign: 'center' }} type="secondary">
            {t('agentSkillModal.github.desc')}
          </Typography.Text>
        </Flexbox>
      </Flexbox>

      {error && <Alert showIcon title={t('agentSkillModal.importError', { error })} type="error" />}

      <Flexbox gap={8}>
        <Typography.Text strong>URL</Typography.Text>
        <Input
          disabled={!resolvedCanCreate}
          placeholder={t('agentSkillModal.github.urlPlaceholder')}
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

ImportFromGithubContent.displayName = 'ImportFromGithubContent';

export const openImportFromGithubModal = (options?: ImportFromGithubModalOptions): ModalInstance =>
  createModal({
    content: (
      <ImportFromGithubContent canCreate={options?.canCreate} onImport={options?.onImport} />
    ),
    footer: null,
    maskClosable: true,
    styles: { header: { display: 'none' } },
    width: 480,
  });
