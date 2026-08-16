'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { memo } from 'react';

import { moderationStyles as styles } from '../../styles';

export const Field = memo<{ children: React.ReactNode; label: string }>(({ children, label }) => (
  <div className={styles.fieldRow}>
    <Text className={styles.fieldLabel} type="secondary">
      {label}
    </Text>
    <div className={styles.fieldValue}>{children}</div>
  </div>
));
Field.displayName = 'ModerationDetailField';

export const Section = memo<{ children: React.ReactNode; title: string }>(({ children, title }) => (
  <Flexbox gap={8} style={{ marginBlockEnd: 20 }}>
    <Text strong>{title}</Text>
    {children}
  </Flexbox>
));
Section.displayName = 'ModerationDetailSection';
