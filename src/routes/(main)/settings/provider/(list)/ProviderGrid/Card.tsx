import { BRANDING_PROVIDER } from '@lobechat/business-const';
import { ProviderCombine, ProviderIcon } from '@lobehub/icons';
import { Avatar, Flexbox, Skeleton, Tag, Text } from '@lobehub/ui';
import { Divider } from 'antd';
import { cssVar, cx } from 'antd-style';
import { isRotatingRefreshOAuthProvider } from 'model-bank/modelProviders';
import { memo, use } from 'react';
import { useTranslation } from 'react-i18next';

import { BrandingProviderCard } from '@/business/client/features/BrandingProviderCard';
import { useIsDark } from '@/hooks/useIsDark';
import { type AiProviderListItem } from '@/types/aiProvider';

import { ProviderSettingsContext } from '../../features/ModelList/ProviderSettingsContext';
import EnableSwitch from './EnableSwitch';
import { styles } from './style';

const isCodingPlanProvider = (id: string) => id.endsWith('codingplan');

interface ProviderCardProps extends AiProviderListItem {
  loading?: boolean;
  onProviderSelect: (provider: string) => void;
}
const ProviderCard = memo<ProviderCardProps>(
  ({ id, description, name, enabled, source, logo, loading, onProviderSelect }) => {
    const { t } = useTranslation(['providers', 'modelProvider']);
    const isDarkMode = useIsDark();
    const { hidePersonalAuth } = use(ProviderSettingsContext);
    // Admin platform surface: chatgpt/chatgptweb/supergrok are hosted through ONE shared platform
    // account (connected in the provider detail), so label them — they stay enableable.
    const sharedOAuthAdmin = Boolean(hidePersonalAuth && isRotatingRefreshOAuthProvider(id));

    if (loading)
      return (
        <Flexbox
          className={cx(isDarkMode ? styles.containerDark : styles.containerLight)}
          gap={24}
          padding={16}
        >
          <Skeleton active />
        </Flexbox>
      );

    if (id === BRANDING_PROVIDER) {
      return <BrandingProviderCard />;
    }

    return (
      <Flexbox className={cx(isDarkMode ? styles.containerDark : styles.containerLight)} gap={24}>
        <Flexbox gap={12} padding={16} width={'100%'}>
          <div
            style={{ cursor: 'pointer' }}
            onClick={() => {
              onProviderSelect(id);
            }}
          >
            <Flexbox gap={12} width={'100%'}>
              <Flexbox horizontal align={'center'} justify={'space-between'}>
                {source === 'builtin' ? (
                  <Flexbox horizontal align={'center'} gap={8}>
                    <ProviderCombine
                      provider={id}
                      size={24}
                      style={{ color: cssVar.colorText }}
                      title={name}
                    />
                    {isCodingPlanProvider(id) && <Tag color={'geekblue'}>{'Coding Plan'}</Tag>}
                  </Flexbox>
                ) : (
                  <Flexbox horizontal align={'center'} gap={12}>
                    {logo ? (
                      <Avatar alt={name || id} avatar={logo} size={28} />
                    ) : (
                      <ProviderIcon
                        provider={id}
                        size={24}
                        style={{ borderRadius: 6 }}
                        type={'avatar'}
                      />
                    )}
                    <Text style={{ fontSize: 16, fontWeight: 'bold' }}>{name || id}</Text>
                  </Flexbox>
                )}
              </Flexbox>
              <Text
                className={styles.desc}
                ellipsis={{
                  rows: 2,
                }}
              >
                {source === 'custom'
                  ? description
                  : t(`${id}.description`, { defaultValue: description })}
              </Text>
            </Flexbox>
          </div>
          <Divider style={{ margin: '4px 0' }} />
          <Flexbox horizontal align={'center'} justify={'space-between'}>
            {sharedOAuthAdmin ? (
              <Tag>{t('providerModels.config.sharedOAuth.tag', { ns: 'modelProvider' })}</Tag>
            ) : (
              <div />
            )}
            <EnableSwitch enabled={enabled} id={id} />
          </Flexbox>
        </Flexbox>
      </Flexbox>
    );
  },
);

export default ProviderCard;
