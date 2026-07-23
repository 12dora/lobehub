'use client';

import { Input, Text, TextArea } from '@lobehub/ui';
import { Button, createModal, useModalContext } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import i18next from 'i18next';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import { buildSkillVersionPayload, type EditableSkillVersionDraft } from './controller';
import type { AdminSkillCreateVersionInput } from './types';
import type { SkillWriteSnapshot } from './writeOperation';

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
    justify-content: flex-end;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;

    @media (width <= 700px) {
      grid-template-columns: 1fr;
    }
  `,
}));

export interface VersionEditorModalProps {
  initialDraft: EditableSkillVersionDraft;
  onDraftChange: (draft: EditableSkillVersionDraft) => void;
  onSubmit: (input: AdminSkillCreateVersionInput) => Promise<void>;
  snapshot: Readonly<SkillWriteSnapshot>;
}

const VersionEditorContent = memo<VersionEditorModalProps>(
  ({ initialDraft, onDraftChange, onSubmit, snapshot }) => {
    const { t } = useTranslation('admin');
    const { close } = useModalContext();
    const [draft, setDraft] = useState(() => structuredClone(initialDraft));
    const [reason, setReason] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const update = <Key extends keyof EditableSkillVersionDraft>(
      key: Key,
      value: EditableSkillVersionDraft[Key],
    ) => {
      const next = { ...draft, [key]: value };
      setDraft(next);
      onDraftChange(structuredClone(next));
      setError(null);
    };

    const submit = async () => {
      const input = buildSkillVersionPayload({
        draft,
        draftToken: snapshot.draftToken,
        reason,
        revision: snapshot.baseRevision,
        skillId: snapshot.id,
      });
      if (!input) {
        setError(t('skillCatalog.version.formInvalid'));
        return;
      }
      setLoading(true);
      setError(null);
      try {
        await onSubmit(structuredClone(input));
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
        <Text type="secondary">{t('skillCatalog.version.desc')}</Text>
        <div className={styles.field}>
          <Text strong>{t('skillCatalog.detail.version.version')}</Text>
          <Input
            disabled={loading}
            maxLength={64}
            value={draft.version}
            onChange={(e) => update('version', e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <Text strong>{t('skillCatalog.detail.version.content')}</Text>
          <TextArea
            disabled={loading}
            rows={10}
            value={draft.content}
            onChange={(e) => update('content', e.target.value)}
          />
        </div>
        <div className={styles.grid}>
          <div className={styles.field}>
            <Text strong>{t('skillCatalog.detail.version.manifest')}</Text>
            <TextArea
              disabled={loading}
              rows={12}
              value={draft.manifestText}
              onChange={(e) => update('manifestText', e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('skillCatalog.detail.version.resources')}</Text>
            <TextArea
              disabled={loading}
              rows={12}
              value={draft.resourcesText}
              onChange={(e) => update('resourcesText', e.target.value)}
            />
          </div>
        </div>
        <div className={styles.field}>
          <Text strong>{t('skillCatalog.form.reason')}</Text>
          <TextArea
            disabled={loading}
            maxLength={2000}
            rows={3}
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
            {t('skillCatalog.version.create')}
          </Button>
        </div>
      </div>
    );
  },
);

VersionEditorContent.displayName = 'AdminSkillVersionEditorContent';

export const createInitialSkillVersionDraft = (
  displayName: string,
  description: string | null,
): EditableSkillVersionDraft => ({
  content: '',
  contentRef: '',
  manifestText: JSON.stringify(
    {
      description: description || displayName,
      displayName,
      localizedDescriptions: {},
      localizedDisplayNames: {},
      permissions: {
        filesystem: 'none',
        network: { allowedHosts: [], enabled: false },
        tools: { allow: [] },
      },
      skillDependencies: [],
      toolDependencies: [],
    },
    null,
    2,
  ),
  resourcesText: '[]',
  version: '1.0.0',
});

export const openVersionEditorModal = (props: VersionEditorModalProps) =>
  createModal({
    content: <VersionEditorContent {...props} />,
    footer: null,
    maskClosable: false,
    title: i18next.t('skillCatalog.version.title', { ns: 'admin' }),
    width: 'min(96vw, 960px)',
  });
