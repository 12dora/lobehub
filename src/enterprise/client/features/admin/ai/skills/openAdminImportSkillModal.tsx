'use client';

import { Input, Text, TextArea } from '@lobehub/ui';
import { Button, createModal, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import i18next from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import { buildApplyImmediateVersionPayload } from '../../skills/controller';
import type { AdminSkillCreateWithVersionInput } from '../../skills/openCreateSkillModal';

const styles = createStaticStyles(({ css }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 14px;
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  footer: css`
    display: flex;
    gap: 8px;
    justify-content: end;
  `,
}));

const skillKeyFromUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').findLast(Boolean) || 'imported-skill';
    return (
      last
        .replace(/\.md$/i, '')
        .replaceAll(/[^\w.-]+/g, '.')
        .replaceAll(/^\.+|\.+$/g, '')
        .slice(0, 120) || 'imported.skill'
    );
  } catch {
    return 'imported.skill';
  }
};

export interface AdminImportSkillModalProps {
  onSubmit: (input: AdminSkillCreateWithVersionInput) => Promise<void>;
}

/**
 * Admin URL/manifest import form (visual parity with user settings import).
 * Fetches raw text from URL when possible; falls back to pasted content.
 * Submits applyImmediate create+version (never toolStore).
 */
const ImportSkillContent = memo<AdminImportSkillModalProps>(({ onSubmit }) => {
  const { t } = useTranslation('admin');
  const { close } = useModalContext();
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [skillKey, setSkillKey] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUrl = async () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError(t('aiSkillSettings.import.urlRequired', { defaultValue: 'Enter a URL.' }));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(trimmed);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      if (!text.trim()) {
        throw new Error('Empty response');
      }
      setContent(text);
      if (!skillKey) setSkillKey(skillKeyFromUrl(trimmed));
      if (!displayName) {
        const firstHeading = text.match(/^#\s+(\S.*)$/m)?.[1]?.trim();
        setDisplayName(firstHeading || skillKeyFromUrl(trimmed));
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.slice(0, 200)
          : t('aiSkillSettings.import.fetchFailed', { defaultValue: 'Failed to fetch URL' }),
      );
    } finally {
      setLoading(false);
    }
  };

  const submit = async () => {
    const name = displayName.trim() || skillKeyFromUrl(url);
    const key = skillKey.trim() || skillKeyFromUrl(url);
    const body = content.trim();
    const why = reason.trim();
    if (!body || !key || !name || !why) {
      setError(
        t('aiSkillSettings.import.required', {
          defaultValue: 'Content, key, display name, and reason are required.',
        }),
      );
      return;
    }
    const version = buildApplyImmediateVersionPayload({
      content: body,
      description: null,
      displayName: name,
      version: '1.0.0',
    });
    if (!version) {
      setError(t('skillCatalog.version.formInvalid'));
      return;
    }
    const input: AdminSkillCreateWithVersionInput = {
      allowBuiltinOverride: false,
      description: null,
      displayName: name,
      distribution: 'default',
      enabled: true,
      reason: why,
      skillKey: key,
      version,
    };
    setLoading(true);
    setError(null);
    try {
      await onSubmit(input);
      close();
    } catch (cause) {
      const mapped = mapEnterpriseError(cause);
      setError(
        mapped
          ? t(mapped.i18nKey as never, { defaultValue: mapped.code })
          : t('skillCatalog.errors.generic'),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.body}>
      <Text type="secondary">
        {t('aiSkillSettings.import.desc', {
          defaultValue:
            'Import skill markdown from a public URL or paste content. Lists the skill for all users when valid.',
        })}
      </Text>
      <div className={styles.field}>
        <Text strong>{t('aiSkillSettings.import.url', { defaultValue: 'URL' })}</Text>
        <Input
          disabled={loading}
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button disabled={loading} size="small" onClick={() => void fetchUrl()}>
          {t('aiSkillSettings.import.fetch', { defaultValue: 'Fetch content' })}
        </Button>
      </div>
      <div className={styles.field}>
        <Text strong>{t('aiSkillSettings.import.content', { defaultValue: 'Skill content' })}</Text>
        <TextArea
          disabled={loading}
          rows={10}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <Text strong>{t('skillCatalog.detail.identity.key')}</Text>
        <Input
          disabled={loading}
          maxLength={128}
          value={skillKey}
          onChange={(e) => setSkillKey(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <Text strong>{t('skillCatalog.form.displayName')}</Text>
        <Input
          disabled={loading}
          maxLength={200}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <Text strong>{t('skillCatalog.form.reason')}</Text>
        <TextArea
          disabled={loading}
          maxLength={2000}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error ? (
        <Text className={styles.error} role="alert">
          {error}
        </Text>
      ) : null}
      <div className={styles.footer}>
        <Button disabled={loading} onClick={close}>
          {t('users.modals.cancel')}
        </Button>
        <Button loading={loading} type="primary" onClick={() => void submit()}>
          {t('aiSkillSettings.actions.create', { defaultValue: 'List skill' })}
        </Button>
      </div>
    </div>
  );
});

ImportSkillContent.displayName = 'AdminImportSkillContent';

export const openAdminImportSkillModal = (props: AdminImportSkillModalProps) =>
  createModal({
    content: <ImportSkillContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('aiSkillSettings.import.title', {
      defaultValue: 'Import skill from URL',
      ns: 'admin',
    }),
    width: 'min(94vw, 720px)',
  });
