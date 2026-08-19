'use client';

import { Tag, Text } from '@lobehub/ui';
import { Button, Input, InputPassword } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { moderationEndpointChanged } from '../../../format';
import { moderationStyles as styles } from '../../../styles';
import type { ModerationConfigView } from '../../draft';
import Field from '../../Field';

export interface ModerationsApiFieldsProps {
  addedApiKeys: string[];
  classifier: ModerationConfigView['classifier'];
  disabled: boolean;
  fieldError?: { field?: string; message: string } | null;
  onAddedKeysChange: (keys: string[]) => void;
  patchClassifier: (patch: Partial<ModerationConfigView['classifier']>) => void;
  persistedBaseUrl?: string;
}

export const ModerationsApiFields = memo<ModerationsApiFieldsProps>(
  ({
    addedApiKeys,
    classifier,
    disabled,
    fieldError,
    onAddedKeysChange,
    patchClassifier,
    persistedBaseUrl,
  }) => {
    const { t } = useTranslation('admin');
    // The server refuses to reuse keys across endpoints, so once the URL is edited the stored
    // keys are already gone from the admin's point of view — say so before they hit 保存.
    const endpointChanged =
      classifier.kind === 'moderations_api' &&
      (classifier.moderationsApi?.apiKeys.length ?? 0) > 0 &&
      moderationEndpointChanged(persistedBaseUrl, classifier.moderationsApi?.baseUrl);

    const patchApi = (patch: Partial<NonNullable<typeof classifier.moderationsApi>>) =>
      patchClassifier({
        moderationsApi: {
          apiKeys: classifier.moderationsApi?.apiKeys ?? [],
          baseUrl: classifier.moderationsApi?.baseUrl ?? '',
          model: classifier.moderationsApi?.model ?? '',
          ...patch,
        },
      });

    return (
      <div className={styles.fieldGrid}>
        <Field
          hint={t('contentModeration.settings.classifier.baseUrlHint')}
          label={t('contentModeration.settings.classifier.baseUrl')}
        >
          <Input
            disabled={disabled}
            placeholder={t('contentModeration.settings.classifier.baseUrlPlaceholder')}
            value={classifier.moderationsApi?.baseUrl ?? ''}
            onChange={(event) => patchApi({ baseUrl: event.target.value })}
          />
        </Field>
        <Field label={t('contentModeration.settings.classifier.apiModel')}>
          <Input
            disabled={disabled}
            placeholder={t('contentModeration.settings.classifier.apiModelPlaceholder')}
            value={classifier.moderationsApi?.model ?? ''}
            onChange={(event) => patchApi({ model: event.target.value })}
          />
        </Field>
        <Field
          wide
          hint={t('contentModeration.settings.classifier.apiKeysHint')}
          label={t('contentModeration.settings.classifier.apiKeys')}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className={styles.formRow}>
              {(classifier.moderationsApi?.apiKeys ?? []).length === 0 ? (
                <Text className={styles.hintText}>
                  {t('contentModeration.settings.classifier.noStoredKeys')}
                </Text>
              ) : (
                (classifier.moderationsApi?.apiKeys ?? []).map((key) => (
                  <Tag
                    closable={!disabled}
                    color={endpointChanged ? 'warning' : undefined}
                    data-testid={`stored-key-${key.fingerprint}`}
                    key={key.fingerprint}
                    onClose={() =>
                      patchApi({
                        apiKeys: (classifier.moderationsApi?.apiKeys ?? []).filter(
                          (item) => item.fingerprint !== key.fingerprint,
                        ),
                      })
                    }
                  >
                    {endpointChanged
                      ? t('contentModeration.settings.classifier.keyWillBeRemoved', {
                          masked: key.masked,
                        })
                      : key.masked}
                  </Tag>
                ))
              )}
            </div>
            {endpointChanged ? (
              <Text data-testid="endpoint-changed-warning" type="warning">
                {t('contentModeration.settings.classifier.endpointChanged')}
              </Text>
            ) : null}
            {fieldError ? (
              <Text data-testid="classifier-field-error" type="danger">
                {fieldError.message}
              </Text>
            ) : null}
            {addedApiKeys.map((value, index) => (
              <div className={styles.toolbarRow} key={`new-key-${index}`}>
                <InputPassword
                  disabled={disabled}
                  placeholder={t('contentModeration.settings.classifier.newKeyPlaceholder')}
                  style={{ width: 320 }}
                  value={value}
                  onChange={(event) => {
                    const next = [...addedApiKeys];
                    next[index] = event.target.value;
                    onAddedKeysChange(next);
                  }}
                />
                <Button
                  disabled={disabled}
                  size="small"
                  type="text"
                  onClick={() => onAddedKeysChange(addedApiKeys.filter((_, i) => i !== index))}
                >
                  {t('contentModeration.settings.classifier.removeKey')}
                </Button>
              </div>
            ))}
            <div>
              <Button
                disabled={disabled}
                size="small"
                onClick={() => onAddedKeysChange([...addedApiKeys, ''])}
              >
                {t('contentModeration.settings.classifier.addKey')}
              </Button>
            </div>
          </div>
        </Field>
      </div>
    );
  },
);

ModerationsApiFields.displayName = 'ModerationModerationsApiFields';
