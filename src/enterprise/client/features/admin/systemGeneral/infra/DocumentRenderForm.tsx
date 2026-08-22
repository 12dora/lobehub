'use client';

import { Input, Segmented } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { DocumentRenderDraft } from './documentRenderDraft';
import { InfraField, InfraSwitchRow } from './InfraField';
import { infraFormStyles as styles } from './styles';

export interface DocumentRenderFormProps {
  disabled: boolean;
  draft: DocumentRenderDraft;
  errors: Record<string, string>;
  onPatch: (next: Partial<DocumentRenderDraft>) => void;
}

/** The numeric fields, in the order they are laid out. Every one of them is a plain integer box. */
const NUMBER_FIELDS = [
  { hint: true, inputMode: 'numeric', key: 'maxPages' },
  { hint: true, inputMode: 'decimal', key: 'maxFileBytesMib' },
  { hint: true, inputMode: 'numeric', key: 'concurrency' },
  { hint: true, inputMode: 'numeric', key: 'timeoutSec' },
  { hint: true, inputMode: 'numeric', key: 'mediaThresholdT2' },
  { hint: true, inputMode: 'numeric', key: 'longEdgePx' },
  { hint: true, inputMode: 'numeric', key: 'thumbEdgePx' },
  { hint: false, inputMode: 'numeric', key: 'contactSheetCols' },
  { hint: false, inputMode: 'numeric', key: 'contactSheetRows' },
  { hint: true, inputMode: 'numeric', key: 'maxDocsPerRequest' },
  { hint: true, inputMode: 'numeric', key: 'maxImagesDefault' },
  { hint: true, inputMode: 'numeric', key: 'retentionDays' },
] as const satisfies ReadonlyArray<{
  hint: boolean;
  inputMode: 'decimal' | 'numeric';
  key: keyof DocumentRenderDraft;
}>;

export const DocumentRenderForm = memo<DocumentRenderFormProps>(
  ({ disabled, draft, errors, onPatch }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.stack}>
        <InfraField
          wide
          error={errors.endpoint}
          hint={t('systemGeneral.documentRender.hints.endpoint')}
          label={t('systemGeneral.documentRender.fields.endpoint')}
        >
          {(field) => (
            <Input
              {...field.control}
              disabled={disabled}
              placeholder="http://document-render:3000"
              value={draft.endpoint}
              onChange={(event) => onPatch({ endpoint: event.target.value })}
            />
          )}
        </InfraField>

        <InfraField
          hint={t('systemGeneral.documentRender.hints.trigger')}
          label={t('systemGeneral.documentRender.fields.trigger')}
        >
          {(field) => (
            <div aria-labelledby={field.labelId} role="group">
              <Segmented
                disabled={disabled}
                value={draft.trigger}
                options={[
                  {
                    label: t('systemGeneral.documentRender.trigger.onUpload'),
                    value: 'onUpload',
                  },
                  {
                    label: t('systemGeneral.documentRender.trigger.onDemand'),
                    value: 'onDemand',
                  },
                ]}
                onChange={(next) => onPatch({ trigger: next as DocumentRenderDraft['trigger'] })}
              />
            </div>
          )}
        </InfraField>

        <div className={styles.fieldGrid}>
          {NUMBER_FIELDS.map((entry) => (
            <InfraField
              error={errors[entry.key]}
              key={entry.key}
              label={t(`systemGeneral.documentRender.fields.${entry.key}` as never)}
              hint={
                entry.hint
                  ? t(`systemGeneral.documentRender.hints.${entry.key}` as never)
                  : undefined
              }
            >
              {(field) => (
                <Input
                  {...field.control}
                  disabled={disabled}
                  inputMode={entry.inputMode}
                  value={draft[entry.key] as string}
                  onChange={(event) => onPatch({ [entry.key]: event.target.value })}
                />
              )}
            </InfraField>
          ))}
        </div>

        <InfraSwitchRow
          checked={draft.pptxAlwaysT2}
          disabled={disabled}
          hint={t('systemGeneral.documentRender.hints.pptxAlwaysT2')}
          label={t('systemGeneral.documentRender.fields.pptxAlwaysT2')}
          onChange={(checked) => onPatch({ pptxAlwaysT2: checked })}
        />
        <InfraSwitchRow
          checked={draft.tilesForDensePages}
          disabled={disabled}
          hint={t('systemGeneral.documentRender.hints.tilesForDensePages')}
          label={t('systemGeneral.documentRender.fields.tilesForDensePages')}
          onChange={(checked) => onPatch({ tilesForDensePages: checked })}
        />
      </div>
    );
  },
);

DocumentRenderForm.displayName = 'AdminDocumentRenderForm';
