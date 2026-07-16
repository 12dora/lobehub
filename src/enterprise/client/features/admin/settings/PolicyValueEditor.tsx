'use client';

import { Input, SliderWithInput, TextArea } from '@lobehub/ui';
import { Select, Switch } from '@lobehub/ui/base-ui';
import { memo, useId } from 'react';
import { useTranslation } from 'react-i18next';

interface PolicyValueEditorProps {
  control: string;
  disabled?: boolean;
  label: string;
  max?: number;
  min?: number;
  onChange: (value: unknown) => void;
  options?: ReadonlyArray<{ labelKey: string; value: string | number | boolean }>;
  step?: number;
  value: unknown;
}

export const PolicyValueEditor = memo<PolicyValueEditorProps>(
  ({ control, value, onChange, options, min, max, step, disabled, label }) => {
    const { t } = useTranslation('admin');
    const fieldId = useId();

    if (control === 'switch') {
      return (
        <>
          <label
            htmlFor={fieldId}
            style={{
              clipPath: 'inset(50%)',
              height: 1,
              overflow: 'hidden',
              position: 'absolute',
              width: 1,
            }}
          >
            {label}
          </label>
          <Switch
            checked={Boolean(value)}
            disabled={disabled}
            id={fieldId}
            onChange={(checked: boolean) => onChange(checked)}
          />
        </>
      );
    }

    if (control === 'select' && options?.length) {
      return (
        <>
          <label
            htmlFor={fieldId}
            style={{
              clipPath: 'inset(50%)',
              height: 1,
              overflow: 'hidden',
              position: 'absolute',
              width: 1,
            }}
          >
            {label}
          </label>
          <Select
            disabled={disabled}
            id={fieldId}
            style={{ minWidth: 180 }}
            value={value as string | number | boolean | undefined}
            options={options.map((option) => ({
              label: t(option.labelKey as never, { defaultValue: String(option.value) }),
              value: option.value,
            }))}
            onChange={(next) => onChange(next)}
          />
        </>
      );
    }

    if (control === 'textarea') {
      return (
        <TextArea
          aria-label={label}
          disabled={disabled}
          rows={4}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    }

    if (control === 'slider') {
      return (
        <div aria-label={label} role="group">
          <SliderWithInput
            disabled={disabled}
            max={max}
            min={min}
            step={step}
            value={typeof value === 'number' ? value : min}
            onChange={onChange}
          />
        </div>
      );
    }

    if (control === 'number') {
      return (
        <Input
          aria-label={label}
          disabled={disabled}
          max={max}
          min={min}
          step={step}
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) => {
            if (event.target.value === '') {
              onChange(undefined);
              return;
            }
            const next = Number(event.target.value);
            onChange(Number.isFinite(next) ? next : event.target.value);
          }}
        />
      );
    }

    return (
      <Input
        aria-label={label}
        disabled={disabled}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
);

PolicyValueEditor.displayName = 'PolicyValueEditor';
