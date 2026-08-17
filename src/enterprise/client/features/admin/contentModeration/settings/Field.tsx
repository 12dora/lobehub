'use client';

import { Icon, Text, Tooltip } from '@lobehub/ui';
import { CircleHelp } from 'lucide-react';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { moderationStyles as styles } from '../styles';

export interface FieldProps {
  children: ReactNode;
  /** Optional line rendered under the control (counters, validation) — dynamic state only. */
  extra?: ReactNode;
  /** Static guidance; shown in a tooltip behind a help icon so rows stay aligned. */
  hint?: ReactNode;
  label: string;
  /** Span every column of the surrounding field grid. */
  wide?: boolean;
}

/**
 * Label + optional help icon + control. Static guidance never sits under the control (it made
 * neighbouring fields misalign); only live feedback such as a character counter goes below.
 */
const Field = memo<FieldProps>(({ children, extra, hint, label, wide }) => {
  const { t } = useTranslation('admin');
  const [open, setOpen] = useState(false);

  return (
    <div className={wide ? `${styles.field} ${styles.fieldWide}` : styles.field}>
      <div className={styles.fieldLabelRow}>
        <Text strong style={{ fontSize: 13 }}>
          {label}
        </Text>
        {hint ? (
          <Tooltip open={open} title={hint} onOpenChange={setOpen}>
            <button
              aria-label={t('contentModeration.settings.helpFor', { field: label })}
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
      {children}
      {extra ? <span className={styles.hintText}>{extra}</span> : null}
    </div>
  );
});

Field.displayName = 'ModerationSettingsField';

export default Field;
