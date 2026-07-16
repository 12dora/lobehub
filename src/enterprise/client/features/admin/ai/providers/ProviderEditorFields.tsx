'use client';

import { Flexbox, Input, InputNumber, Text, TextArea } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type EditableAiProviderDraft, parseJsonObject } from '../controller';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;
    gap: 16px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;

    @media (width <= 800px) {
      grid-template-columns: 1fr;
    }
  `,
}));

interface JsonObjectFieldProps {
  disabled?: boolean;
  label: string;
  onChange: (value: Record<string, unknown>) => void;
  value: Record<string, unknown>;
}

const JsonObjectField = memo<JsonObjectFieldProps>(({ disabled, label, onChange, value }) => {
  const { t } = useTranslation('admin');
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  return (
    <div className={styles.field}>
      <Text strong>{label}</Text>
      <TextArea
        disabled={disabled}
        rows={6}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const parsed = parseJsonObject(next);
          setError(parsed.error);
          if (parsed.value) onChange(parsed.value);
        }}
      />
      {error ? (
        <Text role="alert" type="danger">
          {t(`aiCatalog.editor.json.${error}` as never)}
        </Text>
      ) : null}
    </div>
  );
});

JsonObjectField.displayName = 'AdminAiJsonObjectField';

interface ProviderEditorFieldsProps {
  disabled?: boolean;
  draft: EditableAiProviderDraft;
  providerKey: string;
  updateDraft: <Key extends keyof EditableAiProviderDraft>(
    key: Key,
    value: EditableAiProviderDraft[Key],
  ) => void;
}

const ProviderEditorFields = memo<ProviderEditorFieldsProps>(
  ({ disabled, draft, providerKey, updateDraft }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.card}>
        <div className={styles.grid}>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.editor.providerKey')}</Text>
            <Input disabled value={providerKey} />
            <Text type="secondary">{t('aiCatalog.editor.providerKeyLocked')}</Text>
          </div>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.editor.displayName')}</Text>
            <Input
              disabled={disabled}
              maxLength={200}
              value={draft.displayName}
              onChange={(event) => updateDraft('displayName', event.target.value)}
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.editor.logo')}</Text>
            <Input
              disabled={disabled}
              maxLength={2000}
              value={draft.logo ?? ''}
              onChange={(event) => updateDraft('logo', event.target.value || null)}
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.editor.checkModel')}</Text>
            <Input
              disabled={disabled}
              maxLength={150}
              value={draft.checkModel ?? ''}
              onChange={(event) => updateDraft('checkModel', event.target.value || null)}
            />
          </div>
          <div className={styles.field}>
            <Text strong>{t('aiCatalog.editor.sort')}</Text>
            <InputNumber
              disabled={disabled}
              precision={0}
              value={draft.sort}
              onChange={(value) => updateDraft('sort', typeof value === 'number' ? value : 0)}
            />
          </div>
          <Flexbox gap={12}>
            <Flexbox horizontal align="center" gap={8}>
              <Switch
                checked={draft.enabled}
                disabled={disabled}
                onChange={(value) => updateDraft('enabled', value)}
              />
              <Text>{t('aiCatalog.editor.enabled')}</Text>
            </Flexbox>
            <Flexbox horizontal align="center" gap={8}>
              <Switch
                checked={draft.fetchOnClient}
                disabled={disabled}
                onChange={(value) => updateDraft('fetchOnClient', value)}
              />
              <Text>{t('aiCatalog.editor.fetchOnClient')}</Text>
            </Flexbox>
          </Flexbox>
        </div>
        <div className={styles.field}>
          <Text strong>{t('aiCatalog.editor.description')}</Text>
          <TextArea
            disabled={disabled}
            maxLength={4000}
            rows={3}
            value={draft.description ?? ''}
            onChange={(event) => updateDraft('description', event.target.value || null)}
          />
        </div>
        <div className={styles.grid}>
          <JsonObjectField
            disabled={disabled}
            label={t('aiCatalog.editor.config')}
            value={draft.config}
            onChange={(value) => updateDraft('config', value)}
          />
          <JsonObjectField
            disabled={disabled}
            label={t('aiCatalog.editor.settings')}
            value={draft.settings}
            onChange={(value) => updateDraft('settings', value)}
          />
        </div>
      </div>
    );
  },
);

ProviderEditorFields.displayName = 'AdminAiProviderEditorFields';

export default ProviderEditorFields;
