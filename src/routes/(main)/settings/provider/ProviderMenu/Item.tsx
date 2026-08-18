import { BRANDING_PROVIDER } from '@lobechat/business-const';
import { ProviderIcon } from '@lobehub/icons';
import { Avatar, Center } from '@lobehub/ui';
import { Badge } from 'antd';
import { memo, useMemo } from 'react';
import { useLocation } from 'react-router';

import { ProductLogo } from '@/components/Branding/ProductLogo';
import { isCustomBranding } from '@/const/version';
import NavItem from '@/features/NavPanel/components/NavItem';
import { useProviderName } from '@/hooks/useProviderName';
import { type AiProviderListItem } from '@/types/aiProvider';

import { isBuiltinProviderRow } from './builtinProvider';

interface ProviderItemProps extends AiProviderListItem {
  onClick: (id: string) => void;
}

const ProviderItem = memo<ProviderItemProps>(
  ({ id, name, source, enabled, logo, onClick = () => {} }) => {
    const location = useLocation();
    const isCustom = !isBuiltinProviderRow(id, source);
    /**
     * Builtin ids can opt into a localized name (chatgptweb → 「ChatGPT 网页版」), and are
     * otherwise named by their model-bank card. The STORED name is deliberately not offered as
     * the fallback for them: a platform row keeps the display name it was created with, so a
     * provider renamed on its card ("SuperGrok" → "Grok") kept shadowing the card here while
     * the panel beside it already said Grok. Only a custom provider's own name is authored by
     * the operator, so only that one is echoed back untouched — including on a legacy row whose
     * `source` column is empty, which would otherwise regress to showing its raw id.
     */
    const displayName = useProviderName(id, isCustom ? name || id : undefined);

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
        return pathParts[adminIdx + 1] ?? null;
      }
      return null;
    }, [location.pathname]);

    const providerIcon =
      isCustom && logo ? (
        <Avatar
          alt={displayName}
          avatar={logo}
          shape={'square'}
          size={22}
          style={{ borderRadius: 4 }}
        />
      ) : isCustomBranding && id === BRANDING_PROVIDER ? (
        <ProductLogo size={24} type={'flat'} />
      ) : (
        <ProviderIcon
          provider={id}
          shape={'square'}
          size={22}
          style={{ borderRadius: 4 }}
          type={'avatar'}
        />
      );

    return (
      <NavItem
        active={activeKey === id}
        icon={() => providerIcon}
        title={displayName}
        extra={
          enabled ? (
            <Center width={24}>
              <Badge status="success" />
            </Center>
          ) : undefined
        }
        onClick={() => {
          onClick(id);
        }}
      />
    );
  },
);
export default ProviderItem;
