'use client';

import { Input } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ObjectStorageDraft } from './draft';
import { InfraField, InfraSwitchRow } from './InfraField';
import { SecretField } from './SecretField';
import { infraFormStyles as styles } from './styles';

export interface ObjectStorageFormProps {
  disabled: boolean;
  draft: ObjectStorageDraft;
  /** Field name → resolved validation message. */
  errors: Record<string, string>;
  onPatch: (next: Partial<ObjectStorageDraft>) => void;
}

/** Editable S3 configuration (T8 interface §2). */
export const ObjectStorageForm = memo<ObjectStorageFormProps>(
  ({ disabled, draft, errors, onPatch }) => {
    const { t } = useTranslation('admin');

    return (
      <div className={styles.stack}>
        <div className={styles.fieldGrid}>
          <InfraField
            error={errors.endpoint}
            hint={t('systemGeneral.objectStorage.hints.endpoint')}
            label={t('systemGeneral.objectStorage.fields.endpoint')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                placeholder={t('systemGeneral.objectStorage.placeholders.endpoint')}
                value={draft.endpoint}
                onChange={(event) => onPatch({ endpoint: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            error={errors.region}
            hint={t('systemGeneral.objectStorage.hints.region')}
            label={t('systemGeneral.objectStorage.fields.region')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                placeholder={t('systemGeneral.objectStorage.placeholders.region')}
                value={draft.region}
                onChange={(event) => onPatch({ region: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            error={errors.bucket}
            hint={t('systemGeneral.objectStorage.hints.bucket')}
            label={t('systemGeneral.objectStorage.fields.bucket')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                value={draft.bucket}
                onChange={(event) => onPatch({ bucket: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            error={errors.accessKeyId}
            hint={t('systemGeneral.objectStorage.hints.accessKeyId')}
            label={t('systemGeneral.objectStorage.fields.accessKeyId')}
          >
            {(field) => (
              <Input
                {...field.control}
                autoComplete="off"
                disabled={disabled}
                value={draft.accessKeyId}
                onChange={(event) => onPatch({ accessKeyId: event.target.value })}
              />
            )}
          </InfraField>
          <SecretField
            wide
            disabled={disabled}
            error={errors.secretAccessKey}
            hint={t('systemGeneral.objectStorage.hints.secretAccessKey')}
            label={t('systemGeneral.objectStorage.fields.secretAccessKey')}
            value={draft.secretAccessKey}
            onChange={(next) => onPatch({ secretAccessKey: next })}
          />
          <InfraField
            error={errors.publicDomain}
            hint={t('systemGeneral.objectStorage.hints.publicDomain')}
            label={t('systemGeneral.objectStorage.fields.publicDomain')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                placeholder={t('systemGeneral.objectStorage.placeholders.publicDomain')}
                value={draft.publicDomain}
                onChange={(event) => onPatch({ publicDomain: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            error={errors.previewUrlExpireIn}
            hint={t('systemGeneral.objectStorage.hints.previewUrlExpireIn')}
            label={t('systemGeneral.objectStorage.fields.previewUrlExpireIn')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                inputMode="numeric"
                placeholder="7200"
                value={draft.previewUrlExpireIn}
                onChange={(event) => onPatch({ previewUrlExpireIn: event.target.value })}
              />
            )}
          </InfraField>
        </div>

        <InfraSwitchRow
          checked={draft.forcePathStyle}
          disabled={disabled}
          hint={t('systemGeneral.objectStorage.hints.pathStyle')}
          label={t('systemGeneral.objectStorage.fields.pathStyle')}
          onChange={(checked) => onPatch({ forcePathStyle: checked })}
        />
        <InfraSwitchRow
          checked={draft.setAcl}
          disabled={disabled}
          hint={t('systemGeneral.objectStorage.hints.setAcl')}
          label={t('systemGeneral.objectStorage.fields.setAcl')}
          onChange={(checked) => onPatch({ setAcl: checked })}
        />
      </div>
    );
  },
);

ObjectStorageForm.displayName = 'AdminObjectStorageForm';
