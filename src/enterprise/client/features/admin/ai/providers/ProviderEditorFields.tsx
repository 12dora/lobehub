'use client';

import { Flexbox, Input, InputNumber, Text, TextArea } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AiProviderJsonField, EditableAiProviderDraft } from '../controller';

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
  error: string | null;
  field: AiProviderJsonField;
  label: string;
  onChange: (field: AiProviderJsonField, value: string) => void;
  value: string;
}

const JsonObjectField = memo<JsonObjectFieldProps>(
  ({ disabled, error, field, label, onChange, value }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.field}>
        <Text strong>{label}</Text>
        <TextArea
          disabled={disabled}
          rows={6}
          value={value}
          onChange={(event) => onChange(field, event.target.value)}
        />
        {error ? (
          <Text role="alert" type="danger">
            {t(`aiCatalog.editor.json.${error}` as never)}
          </Text>
        ) : null}
      </div>
    );
  },
);

JsonObjectField.displayName = 'AdminAiJsonObjectField';

interface ProviderEditorFieldsProps {
  disabled?: boolean;
  draft: EditableAiProviderDraft;
  jsonErrors: Record<AiProviderJsonField, string | null>;
  providerKey: string;
  updateDraft: <Key extends keyof EditableAiProviderDraft>(
    key: Key,
    value: EditableAiProviderDraft[Key],
  ) => void;
}

const ProviderEditorFields = memo<ProviderEditorFieldsProps>(
  ({ disabled, draft, jsonErrors, providerKey, updateDraft }) => {
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
            error={jsonErrors.configText}
            field="configText"
            label={t('aiCatalog.editor.config')}
            value={draft.configText}
            onChange={updateDraft}
          />
          <JsonObjectField
            disabled={disabled}
            error={jsonErrors.settingsText}
            field="settingsText"
            label={t('aiCatalog.editor.settings')}
            value={draft.settingsText}
            onChange={updateDraft}
          />
        </div>
      </div>
    );
  },
);

ProviderEditorFields.displayName = 'AdminAiProviderEditorFields';

export default ProviderEditorFields;
