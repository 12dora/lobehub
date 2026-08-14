'use client';

import { Flexbox } from '@lobehub/ui';
import { isPersonalOAuthOnlyProvider } from 'model-bank/modelProviders';
import { memo, use } from 'react';

import { useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';
import { useServerConfigStore } from '@/store/serverConfig';

import ModelList from '../../features/ModelList';
import { ProviderSettingsContext } from '../../features/ModelList/ProviderSettingsContext';
import { type ProviderConfigProps } from '../../features/ProviderConfig';
import ProviderConfig from '../../features/ProviderConfig';

interface ProviderDetailProps extends ProviderConfigProps {
  showConfig?: boolean;
}
const ProviderDetail = memo<ProviderDetailProps>(({ showConfig = true, ...card }) => {
  const useFetchAiProviderItem = useAiInfraStore((s) => s.useFetchAiProviderItem);
  const useFetchAiProviderList = useAiInfraStore((s) => s.useFetchAiProviderList);
  const isMobile = useServerConfigStore((s) => s.isMobile);
  const { hidePersonalAuth } = use(ProviderSettingsContext);
  // Admin platform surface: personal-OAuth-only providers have no platform catalog row,
  // so model management (platform mutations) cannot apply — ProviderConfig explains why.
  const platformUnsupported = Boolean(hidePersonalAuth && isPersonalOAuthOnlyProvider(card.id));

  useFetchAiProviderList({ enabled: isMobile });
  useFetchAiProviderItem(card.id);

  return (
    <Flexbox gap={24} paddingBlock={8}>
      {showConfig && <ProviderConfig {...card} />}
      {!platformUnsupported && <ModelList id={card.id} {...card.settings} />}
    </Flexbox>
  );
});

export default ProviderDetail;
