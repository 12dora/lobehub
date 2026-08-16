'use client';

import { ColorSwatches, Input, primaryColors } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { FieldHint, fieldStyles } from './fieldPrimitives';

/** The stored contract: 6-digit hex or null. No shorthand, no alpha, no named colours. */
const HEX_PATTERN = /^#[\dA-F]{6}$/i;

/** The `default` swatch of `ColorSwatches` — "no brand colour", stored as null. */
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

const PRESET_KEYS = [
  'red',
  'orange',
  'gold',
  'yellow',
  'lime',
  'green',
  'cyan',
  'blue',
  'geekblue',
  'purple',
  'magenta',
  'volcano',
] as const;

export const isValidPrimaryColor = (value: string | null): boolean =>
  value === null || HEX_PATTERN.test(value);

/** Empty / cleared / transparent all mean "no colour" — never the empty string, which fails the server regex. */
export const normalizePrimaryColor = (value?: string): string | null => {
  const next = value?.trim();
  if (!next || next === TRANSPARENT || next === 'transparent') return null;
  return next;
};

const styles = createStaticStyles(({ css }) => ({
  preview: css`
    flex-shrink: 0;

    width: 24px;
    height: 24px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusSM};
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  `,
}));

interface PrimaryColorFieldProps {
  disabled: boolean;
  label: string;
  onChange: (value: string | null) => void;
  value: string | null;
}

export const PrimaryColorField = memo<PrimaryColorFieldProps>(
  ({ disabled, label, onChange, value }) => {
    const { t } = useTranslation('admin');
    const { t: tColor } = useTranslation('color');
    const id = useId();
    const invalid = !isValidPrimaryColor(value);
    const colors = useMemo(
      () => [
        { color: TRANSPARENT, key: 'default', title: tColor('default') },
        ...PRESET_KEYS.map((key) => ({ color: primaryColors[key], key, title: tColor(key) })),
      ],
      [tColor],
    );

    return (
      <div className={fieldStyles.field}>
        <div className={fieldStyles.labelRow}>
          <label className={fieldStyles.label} htmlFor={id}>
            {label}
          </label>
          <FieldHint field={label} title={t('branding.fields.primaryColorHint')} />
        </div>
        <div className={styles.row}>
          <span
            className={styles.preview}
            style={{ background: invalid || !value ? 'transparent' : value }}
          />
          <Input
            disabled={disabled}
            id={id}
            placeholder="#1677FF"
            status={invalid ? 'error' : undefined}
            style={{ width: 140 }}
            value={value ?? ''}
            onChange={(event) => onChange(event.target.value || null)}
          />
          <ColorSwatches
            enableColorPicker
            colors={colors}
            size={22}
            style={disabled ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
            value={value ?? TRANSPARENT}
            texts={{
              custom: t('branding.fields.primaryColorCustom'),
              presets: t('branding.fields.primaryColorPresets'),
            }}
            onChange={(color) => {
              if (disabled) return;
              onChange(normalizePrimaryColor(color));
            }}
          />
        </div>
        {invalid ? (
          <span className={fieldStyles.error}>{t('branding.fields.primaryColorInvalid')}</span>
        ) : null}
      </div>
    );
  },
);

PrimaryColorField.displayName = 'BrandingPrimaryColorField';
