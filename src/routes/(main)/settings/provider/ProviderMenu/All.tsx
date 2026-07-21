import { WalletCards } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import NavItem from '@/features/NavPanel/components/NavItem';

export const PROVIDER_ALL_PATH = 'all';

const All = memo((props: { onClick: (activeTab: string) => void }) => {
  const { onClick } = props;
  const { t } = useTranslation('modelProvider');
  const location = useLocation();

  // Extract providerId from pathname:
  // - /settings/provider/xxx
  // - /admin/ai/providers/xxx (admin parity page)
  const activeKey = useMemo(() => {
    const pathParts = location.pathname.split('/').filter(Boolean);
    const settingsIdx = pathParts.indexOf('provider');
    if (settingsIdx >= 0 && pathParts[settingsIdx - 1] === 'settings') {
      return pathParts[settingsIdx + 1] ?? null;
    }
    const adminIdx = pathParts.indexOf('providers');
    if (adminIdx >= 0 && pathParts[adminIdx - 1] === 'ai' && pathParts[0] === 'admin') {
      return pathParts[adminIdx + 1] ?? PROVIDER_ALL_PATH;
    }
    return null;
  }, [location.pathname]);

  return (
    <NavItem
      active={activeKey === PROVIDER_ALL_PATH}
      icon={WalletCards}
      title={t('menu.all')}
      onClick={() => {
        onClick(PROVIDER_ALL_PATH);
      }}
    />
  );
});
export default All;
