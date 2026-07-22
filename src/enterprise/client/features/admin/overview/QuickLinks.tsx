'use client';

import { Icon } from '@lobehub/ui';
import { BarChart3, Bot, Users } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { overviewStyles as styles } from './styles';

const LINKS = [
  {
    descKey: 'overview.quickLinks.statsDesc' as const,
    icon: BarChart3,
    path: '/admin/stats',
    titleKey: 'overview.quickLinks.statsTitle' as const,
  },
  {
    descKey: 'overview.quickLinks.usersDesc' as const,
    icon: Users,
    path: '/admin/users',
    titleKey: 'overview.quickLinks.usersTitle' as const,
  },
  {
    descKey: 'overview.quickLinks.providersDesc' as const,
    icon: Bot,
    path: '/admin/ai/providers',
    titleKey: 'overview.quickLinks.providersTitle' as const,
  },
] as const;

const QuickLinks = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.stack}>
      <h2 className={styles.sectionTitle}>{t('overview.quickLinks.title')}</h2>
      <div className={styles.linkGrid}>
        {LINKS.map((item) => (
          <Link className={styles.linkCard} key={item.path} to={item.path}>
            <Icon icon={item.icon} size={18} />
            <span className={styles.linkTitle}>{t(item.titleKey)}</span>
            <p className={styles.linkDesc}>{t(item.descKey)}</p>
          </Link>
        ))}
      </div>
    </div>
  );
});

QuickLinks.displayName = 'AdminOverviewQuickLinks';

export default QuickLinks;
