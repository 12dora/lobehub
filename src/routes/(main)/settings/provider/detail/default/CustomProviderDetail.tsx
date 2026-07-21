'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';

import Loading from '@/components/Loading/BrandTextLoading';
import { aiProviderSelectors, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

import ModelList from '../../features/ModelList';
import ProviderConfig from '../../features/ProviderConfig';

/**
 * Custom (user-defined) provider detail — data via scoped aiInfra store so admin
 * adapter / SWR scope is respected (no direct user aiProviderService import).
 */
const CustomProviderDetail = memo<{ id: string }>(({ id }) => {
  const useFetchAiProviderItem = useAiInfraStore((s) => s.useFetchAiProviderItem);
  const { isLoading } = useFetchAiProviderItem(id);
  const data = useAiInfraStore(aiProviderSelectors.providerDetailById(id));

  if (isLoading || !data || !data.id) return <Loading debugId="Provider > CustomProviderDetail" />;

  return (
    <Flexbox gap={24} paddingBlock={8}>
      <ProviderConfig {...data} id={id} name={data.name || ''} />
      <ModelList id={id} />
    </Flexbox>
  );
});

export default CustomProviderDetail;
