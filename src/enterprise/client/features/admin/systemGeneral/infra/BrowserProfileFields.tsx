'use client';

import { Select } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminBrowserProfileOptions } from '@/enterprise/client/services/adminSystem';

import type { BrowserProfileDraft, BrowserProfileSelection } from './browserProfileSelection';
import { InfraField } from './InfraField';
import { infraFormStyles as styles } from './styles';

export interface BrowserProfileFieldsProps {
  disabled: boolean;
  onChange: (next: Partial<BrowserProfileSelection>) => void;
  /** Already filtered down to what is true of the chosen machine. */
  options: AdminBrowserProfileOptions;
  selection: BrowserProfileDraft;
}

const toSelectOptions = (entries: readonly { id: string; label: string }[]) =>
  entries.map((entry) => ({ label: entry.label, value: entry.id }));

/**
 * The fingerprint as six curated choices.
 *
 * Nothing here is free text. A user-agent typed by hand disagrees with the TLS profile the platform
 * impersonates, and a language that does not belong to its timezone is the same kind of tell — so
 * every field is a pool the server composed and will validate the choice against.
 */
export const BrowserProfileFields = memo<BrowserProfileFieldsProps>(
  ({ disabled, onChange, options, selection }) => {
    const { t } = useTranslation('admin');

    const items = useMemo(
      () => [
        {
          entries: options.chrome,
          key: 'chromeId' as const,
          label: t('browserProfile.fields.chrome'),
        },
        {
          entries: options.systems,
          key: 'systemId' as const,
          label: t('browserProfile.fields.platform'),
        },
        {
          entries: options.locales,
          key: 'localeId' as const,
          label: t('browserProfile.fields.localeTimezone'),
        },
        {
          entries: options.screens,
          key: 'screenId' as const,
          label: t('browserProfile.fields.screen'),
        },
        {
          entries: options.compute,
          key: 'computeId' as const,
          label: t('browserProfile.fields.compute'),
        },
        {
          entries: options.webgl,
          key: 'webglId' as const,
          label: t('browserProfile.fields.webgl'),
        },
      ],
      [options, t],
    );

    return (
      <div className={styles.fieldGrid}>
        {items.map((item) => (
          <InfraField
            // An unresolved dimension is the operator's to answer, so it reads as a field waiting
            // for them rather than as a value the card quietly picked.
            error={selection[item.key] ? undefined : t('systemGeneral.errors.required')}
            key={item.key}
            label={item.label}
          >
            {(field) => (
              <Select
                {...field.control}
                disabled={disabled}
                options={toSelectOptions(item.entries)}
                placeholder={t('systemGeneral.values.unset')}
                style={{ width: '100%' }}
                value={selection[item.key] ?? null}
                onChange={(next) => {
                  if (typeof next !== 'string') return;
                  onChange({ [item.key]: next });
                }}
              />
            )}
          </InfraField>
        ))}
      </div>
    );
  },
);

BrowserProfileFields.displayName = 'AdminBrowserProfileFields';
