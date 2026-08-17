'use client';

import { Button, InputPassword } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { InfraSecretDraft } from './draft';
import { InfraField } from './InfraField';
import { infraFormStyles as styles } from './styles';

export interface SecretFieldProps {
  disabled?: boolean;
  error?: string;
  hint?: string;
  label: string;
  onChange: (next: InfraSecretDraft) => void;
  value: InfraSecretDraft;
  wide?: boolean;
}

/**
 * Write-only credential input.
 *
 * The server never returns a stored secret, so the control states the three intents plainly:
 * leaving it blank keeps what is stored, typing replaces it, and 清除 removes it. Without the
 * explicit clear action "empty" would be ambiguous and an admin could never delete a credential.
 */
export const SecretField = memo<SecretFieldProps>(
  ({ disabled, error, hint, label, onChange, value, wide }) => {
    const { t } = useTranslation('admin');
    const keeping = value.stored && !value.cleared;

    return (
      <InfraField
        error={error}
        hint={hint}
        label={label}
        note={value.cleared ? t('systemGeneral.secret.clearedHint') : undefined}
        wide={wide}
      >
        {(field) => (
          <div className={styles.actions}>
            <InputPassword
              {...field.control}
              autoComplete="new-password"
              disabled={disabled || value.cleared}
              style={{ flex: 1, minWidth: 160 }}
              value={value.value}
              placeholder={
                keeping
                  ? t('systemGeneral.secret.storedPlaceholder')
                  : t('systemGeneral.secret.enterPlaceholder')
              }
              onChange={(event) =>
                onChange({ ...value, cleared: false, value: event.target.value })
              }
            />
            {value.stored ? (
              <Button
                disabled={disabled}
                size="small"
                onClick={() =>
                  onChange(
                    value.cleared
                      ? { ...value, cleared: false }
                      : { ...value, cleared: true, value: '' },
                  )
                }
              >
                {t(value.cleared ? 'systemGeneral.secret.undoClear' : 'systemGeneral.secret.clear')}
              </Button>
            ) : null}
          </div>
        )}
      </InfraField>
    );
  },
);

SecretField.displayName = 'AdminInfraSecretField';
