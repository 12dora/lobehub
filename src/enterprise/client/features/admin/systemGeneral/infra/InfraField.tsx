'use client';

import { Icon, Tooltip } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { CircleHelp } from 'lucide-react';
import { memo, type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { infraFormStyles as styles } from './styles';

/** Props a control must spread so the visible label, hint and error apply to it. */
export interface InfraFieldControlProps {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'id': string;
}

export interface InfraFieldRenderProps {
  control: InfraFieldControlProps;
  /** For controls that are not labelable elements (segmented groups): `aria-labelledby`. */
  labelId: string;
}

export interface InfraFieldProps {
  children: ReactNode | ((field: InfraFieldRenderProps) => ReactNode);
  /** Validation message for this control; announced through `aria-describedby`. */
  error?: string;
  /** Static guidance — lives in a tooltip so neighbouring rows stay aligned. */
  hint?: string;
  label: string;
  /** Extra line under the control (e.g. "will be cleared on save"), also described to the control. */
  note?: string;
  /** Span the whole field grid. */
  wide?: boolean;
}

/**
 * Label + optional help icon + control, with room for one validation line underneath.
 *
 * Guidance never sits under the control: in a two-column grid a paragraph on one field pushes its
 * neighbour out of alignment, which is what made the previous infrastructure cards hard to scan.
 *
 * The label is a real `<label htmlFor>` and the error/note ids are handed back through the render
 * prop, so screen readers get the same association the sighted layout implies.
 */
export const InfraField = memo<InfraFieldProps>(({ children, error, hint, label, note, wide }) => {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);
  const reactId = useId();
  const controlId = `infra-${reactId}`;
  const labelId = `${controlId}-label`;
  const errorId = `${controlId}-error`;
  const noteId = `${controlId}-note`;

  const describedBy = [error ? errorId : null, note ? noteId : null].filter(Boolean).join(' ');
  const render: InfraFieldRenderProps = {
    control: {
      id: controlId,
      ...(error ? { 'aria-invalid': true } : {}),
      ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    },
    labelId,
  };

  return (
    <div className={wide ? `${styles.field} ${styles.fieldWide}` : styles.field}>
      <div className={styles.labelRow}>
        <label className={styles.label} htmlFor={controlId} id={labelId}>
          {label}
        </label>
        {hint ? (
          <Tooltip open={open} title={hint} onOpenChange={setOpen}>
            <button
              aria-label={t('systemGeneral.helpFor', { field: label })}
              className={styles.helpButton}
              type="button"
              onBlur={() => setOpen(false)}
              onFocus={() => setOpen(true)}
            >
              <Icon icon={CircleHelp} size={14} />
            </button>
          </Tooltip>
        ) : null}
      </div>
      {typeof children === 'function' ? children(render) : children}
      {note ? (
        <span className={styles.hint} id={noteId}>
          {note}
        </span>
      ) : null}
      {error ? (
        <span className={styles.error} id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
});

InfraField.displayName = 'AdminInfraField';

export interface InfraSwitchRowProps {
  checked: boolean;
  disabled?: boolean;
  /** One line under the row explaining what turning it on changes. */
  hint?: string;
  label: string;
  onChange: (checked: boolean) => void;
}

/**
 * A boolean setting as a labelled row. `Switch` renders a `<button role="switch">`, which is a
 * labelable element, so `<label htmlFor>` gives it its accessible name.
 */
export const InfraSwitchRow = memo<InfraSwitchRowProps>(
  ({ checked, disabled, hint, label, onChange }) => {
    const reactId = useId();
    const controlId = `infra-switch-${reactId}`;

    return (
      <div className={styles.switchField}>
        <div className={styles.switchRow}>
          <label className={styles.label} htmlFor={controlId}>
            {label}
          </label>
          <Switch checked={checked} disabled={disabled} id={controlId} onChange={onChange} />
        </div>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
      </div>
    );
  },
);

InfraSwitchRow.displayName = 'AdminInfraSwitchRow';
