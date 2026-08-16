'use client';

import { memo, type ReactNode } from 'react';

import { moderationStyles as styles } from '../styles';

export interface SettingsSectionProps {
  actions?: ReactNode;
  children: ReactNode;
  description: string;
  title: string;
}

/** One titled block of the 设置 form; every section states what it changes in one line. */
const SettingsSection = memo<SettingsSectionProps>(({ actions, children, description, title }) => (
  <section className={styles.section}>
    <div className={styles.cardHeader}>
      <div>
        <h3 className={styles.sectionTitle}>{title}</h3>
        <p className={styles.sectionDesc}>{description}</p>
      </div>
      {actions}
    </div>
    {children}
  </section>
));

SettingsSection.displayName = 'ModerationSettingsSection';

export default SettingsSection;
