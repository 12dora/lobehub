'use client';

import { Center, Flexbox, Icon, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ServerCrash } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import Loading from '@/components/Loading/BrandTextLoading';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { aiProviderSelectors, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

import ModelList from '../../features/ModelList';
import ProviderConfig from '../../features/ProviderConfig';
import { providerSettingsPath } from '../../providerRouteBase';

const styles = createStaticStyles(({ css }) => ({
  description: css`
    max-width: 360px;

    font-size: ${cssVar.fontSize};
    color: ${cssVar.colorTextDescription};
    text-align: center;
    text-wrap: balance;
  `,
  icon: css`
    font-size: 40px;
    color: ${cssVar.colorTextSecondary};
  `,
  iconCircle: css`
    display: flex;
    align-items: center;
    justify-content: center;

    width: 80px;
    height: 80px;
    border-radius: 50%;

    background: ${cssVar.colorFillSecondary};
  `,
  title: css`
    font-size: ${cssVar.fontSizeLG};
    font-weight: 500;
  `,
}));

/**
 * Custom (user-defined) provider detail — data via scoped aiInfra store so admin
 * adapter / SWR scope is respected (no direct user aiProviderService import).
 *
 * When the detail fetch finishes without a row (e.g. orphaned navigation after a
 * create that wrote to the wrong scope), show an explicit empty state instead of
 * infinite BrandTextLoading.
 */
const CustomProviderDetail = memo<{ id: string }>(({ id }) => {
  const { t } = useTranslation('modelProvider');
  const navigate = useWorkspaceAwareNavigate();
  const location = useLocation();
  const useFetchAiProviderItem = useAiInfraStore((s) => s.useFetchAiProviderItem);
  const { isLoading } = useFetchAiProviderItem(id);
  const data = useAiInfraStore(aiProviderSelectors.providerDetailById(id));

  if (isLoading) return <Loading debugId="Provider > CustomProviderDetail" />;

  if (!data || !data.id) {
    return (
      <Center gap={24} paddingBlock={80} width={'100%'}>
        <div className={styles.iconCircle}>
          <Icon className={styles.icon} icon={ServerCrash} />
        </div>
        <Flexbox align={'center'} gap={8}>
          <div className={styles.title}>{t('detail.notFound.title')}</div>
          <Text className={styles.description}>{t('detail.notFound.desc')}</Text>
        </Flexbox>
        <Button
          type={'primary'}
          onClick={() => navigate(providerSettingsPath(location.pathname, 'all'))}
        >
          {t('detail.notFound.backToList')}
        </Button>
      </Center>
    );
  }

  return (
    <Flexbox gap={24} paddingBlock={8}>
      <ProviderConfig {...data} id={id} name={data.name || ''} />
      <ModelList id={id} />
    </Flexbox>
  );
});

export default CustomProviderDetail;
