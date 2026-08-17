'use client';

import { Text } from '@lobehub/ui';
import { memo, type ReactNode } from 'react';

import { networkProxyStyles as styles } from './styles';

export interface SectionProps {
  actions?: ReactNode;
  children: ReactNode;
  description: string;
  title: string;
}

/** One titled block of the 网络代理 tab; the description says what this block changes. */
export const Section = memo<SectionProps>(({ actions, children, description, title }) => (
  <section className={styles.section}>
    <div className={styles.sectionHeader}>
      <div>
        <h3 className={styles.sectionTitle}>{title}</h3>
        <p className={styles.sectionDesc}>{description}</p>
      </div>
      {actions ? <div className={styles.inlineActions}>{actions}</div> : null}
    </div>
    {children}
  </section>
));

Section.displayName = 'NetworkProxySection';

export interface FieldProps {
  children: ReactNode;
  hint?: ReactNode;
  label: string;
}

/** Label + control + a one-line hint that explains the consequence, not the mechanics. */
export const Field = memo<FieldProps>(({ children, hint, label }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
    <Text strong style={{ fontSize: 13 }}>
      {label}
    </Text>
    {children}
    {hint ? <span className={styles.hintText}>{hint}</span> : null}
  </div>
));

Field.displayName = 'NetworkProxyField';
