'use client';

import { Input, Text, TextArea } from '@lobehub/ui';
import { Select, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { EditableSkillIdentityDraft } from './controller';

const styles = createStaticStyles(({ css }) => ({
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};

    @media (width <= 700px) {
      grid-template-columns: 1fr;
    }
  `,
  span: css`
    grid-column: 1 / -1;
  `,
}));

interface SkillIdentityEditorProps {
  disabled: boolean;
  draft: EditableSkillIdentityDraft;
  onChange: <Key extends keyof EditableSkillIdentityDraft>(
    key: Key,
    value: EditableSkillIdentityDraft[Key],
  ) => void;
}

const SkillIdentityEditor = memo<SkillIdentityEditorProps>(({ disabled, draft, onChange }) => {
  const { t } = useTranslation('admin');
  return (
    <section className={styles.grid}>
      <div className={styles.field}>
        <Text strong>{t('skillCatalog.form.displayName')}</Text>
        <Input
          disabled={disabled}
          maxLength={200}
          value={draft.displayName}
          onChange={(event) => onChange('displayName', event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <Text strong>{t('skillCatalog.detail.identity.distribution')}</Text>
        <Select
          disabled={disabled}
          value={draft.distribution}
          options={(['default', 'mandatory', 'optional'] as const).map((value) => ({
            label: t(`skillCatalog.distribution.${value}` as never),
            value,
          }))}
          onChange={(value) =>
            onChange('distribution', value as EditableSkillIdentityDraft['distribution'])
          }
        />
      </div>
      <div className={`${styles.field} ${styles.span}`}>
        <Text strong>{t('skillCatalog.form.description')}</Text>
        <TextArea
          disabled={disabled}
          maxLength={4000}
          rows={4}
          value={draft.description}
          onChange={(event) => onChange('description', event.target.value)}
        />
      </div>
      <label className={styles.span}>
        <Switch
          checked={draft.enabled}
          disabled={disabled}
          onChange={(value) => onChange('enabled', value)}
        />{' '}
        {t('skillCatalog.form.enabled')}
      </label>
    </section>
  );
});

SkillIdentityEditor.displayName = 'AdminSkillIdentityEditor';

export default SkillIdentityEditor;
