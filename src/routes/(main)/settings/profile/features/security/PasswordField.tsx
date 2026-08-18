'use client';

import { Text } from '@lobehub/ui';
import { InputPassword } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ChangeEvent, memo, useId } from 'react';

const styles = createStaticStyles(({ css }) => ({
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
  `,
  hint: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextDescription};
  `,
  hintError: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorError};
  `,
  label: css`
    font-size: ${cssVar.fontSizeSM};
    font-weight: 500;
  `,
}));

interface PasswordFieldProps {
  autoComplete?: 'current-password' | 'new-password';
  autoFocus?: boolean;
  disabled?: boolean;
  /** Rendered under the input in the error colour. Takes precedence over `hint`. */
  error?: string;
  /** Persistent helper copy (e.g. the length rule). Turns red while `errorTone` is set. */
  hint?: string;
  /** Paint `hint` as an error without duplicating the copy (used for the length rule). */
  hintIsError?: boolean;
  label: string;
  maxLength?: number;
  onChange: (value: string) => void;
  onEnter?: () => void;
  value: string;
}

/**
 * Label + password input + a single message slot. Validation messages stay pinned to the
 * field that caused them rather than being fired as a toast — the repo precedent is
 * `useSignIn.ts`, and a security form is exactly where a message that vanishes in 3s is
 * most expensive.
 */
const PasswordField = memo<PasswordFieldProps>(
  ({
    autoComplete = 'current-password',
    autoFocus,
    disabled,
    error,
    hint,
    hintIsError,
    label,
    maxLength,
    onChange,
    onEnter,
    value,
  }) => {
    const id = useId();
    const messageId = `${id}-message`;
    const message = error ?? hint;
    const isError = Boolean(error) || Boolean(hintIsError);

    return (
      <div className={styles.field}>
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
        <InputPassword
          aria-describedby={message ? messageId : undefined}
          aria-invalid={isError || undefined}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          disabled={disabled}
          id={id}
          maxLength={maxLength}
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !onEnter) return;
            event.preventDefault();
            onEnter();
          }}
        />
        {message && (
          <Text
            as="span"
            className={isError ? styles.hintError : styles.hint}
            id={messageId}
            role={error ? 'alert' : undefined}
          >
            {message}
          </Text>
        )}
      </div>
    );
  },
);

PasswordField.displayName = 'SecurityPasswordField';

export default PasswordField;
