'use client';

import { Text } from '@lobehub/ui';
import { memo, type ReactNode } from 'react';

import { moderationStyles as styles } from '../styles';

export interface FieldProps {
  children: ReactNode;
  hint?: ReactNode;
  label: string;
}

/** Label + control + optional one-line hint. Hints explain consequences, not mechanics. */
const Field = memo<FieldProps>(({ children, hint, label }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <Text strong style={{ fontSize: 13 }}>
      {label}
    </Text>
    {children}
    {hint ? <span className={styles.hintText}>{hint}</span> : null}
  </div>
));

Field.displayName = 'ModerationSettingsField';

export default Field;
