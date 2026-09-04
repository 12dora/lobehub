'use client';

import { Block, Button, Checkbox, Empty, Flexbox, Text } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { HeartHandshake, Undo2Icon } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { resolveManagedBoolean } from '@/features/PlatformSettingSourceBadge/managedControlValue';
import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors } from '@/store/user/selectors';

import LobeMessage from '../components/LobeMessage';
import OnboardingFooterActions from '../components/OnboardingFooterActions';

type DataMode = 'share' | 'privacy';

interface DataModeStepProps {
  onBack: () => void;
  onNext: () => void;
}

const DataModeStep = memo<DataModeStepProps>(({ onBack, onNext }) => {
  const { t } = useTranslation('desktop-onboarding');
  const { name: appName } = useBranding();
  const telemetryEnabled = useUserStore(userGeneralSettingsSelectors.telemetry);
  const updateGeneralConfig = useUserStore((s) => s.updateGeneralConfig);
  const telemetryMeta = usePlatformSettingMeta('general.telemetry');
  const [pickedMode, setPickedMode] = useState<DataMode>(telemetryEnabled ? 'share' : 'privacy');

  // `locked` is fail-closed (also true while the policy loads), and the enforced value comes from
  // the policy rather than the store, which can still hold the pre-policy telemetry choice.
  const managed = telemetryMeta.locked;
  const selectedMode: DataMode = resolveManagedBoolean(telemetryMeta, pickedMode === 'share')
    ? 'share'
    : 'privacy';

  const setMode = useCallback(
    (mode: DataMode) => {
      if (managed) return;
      setPickedMode(mode);
      const nextTelemetry = mode === 'share';
      if (telemetryEnabled !== nextTelemetry) {
        void updateGeneralConfig({ telemetry: nextTelemetry });
      }
    },
    [managed, telemetryEnabled, updateGeneralConfig],
  );

  const checkIcon = (
    <Checkbox
      checked
      backgroundColor={cssVar.colorSuccess}
      shape={'circle'}
      size={20}
      style={{ position: 'absolute', right: 12, top: 12 }}
    />
  );

  return (
    <Flexbox gap={16} style={{ height: '100%', minHeight: '100%' }}>
      <Flexbox>
        <LobeMessage sentences={[t('screen4.title'), t('screen4.title2'), t('screen4.title3')]} />
        <Text as={'p'}>{t('screen4.description')}</Text>
      </Flexbox>
      <Flexbox gap={16} style={{ width: '100%' }}>
        {/* Shared data option */}
        <Block
          clickable={!managed}
          flex={1}
          gap={16}
          padding={16}
          variant={'outlined'}
          style={{
            borderColor: selectedMode === 'share' ? cssVar.colorSuccess : undefined,
            opacity: managed ? 0.6 : undefined,
          }}
          onClick={() => setMode('share')}
        >
          {selectedMode === 'share' && checkIcon}
          <Empty
            description={t('screen4.share.description', { appName })}
            icon={HeartHandshake}
            padding={0}
            title={t('screen4.share.title', { appName })}
            type={'page'}
            descriptionProps={{
              fontSize: 14,
            }}
            titleProps={{
              fontSize: 18,
            }}
          />
          <Flexbox as={'ul'} gap={4} style={{ listStyle: 'none', padding: 0 }}>
            <li>
              <Text>• {t('screen4.share.items.1')}</Text>
            </li>
            <li>
              <Text>• {t('screen4.share.items.2')}</Text>
            </li>
            <li>
              <Text>• {t('screen4.share.items.3')}</Text>
            </li>
          </Flexbox>
        </Block>

        {/* Privacy mode option */}
        <Block
          clickable={!managed}
          flex={1}
          gap={6}
          padding={16}
          variant={'outlined'}
          style={{
            borderColor: selectedMode === 'privacy' ? cssVar.colorSuccess : undefined,
            opacity: managed ? 0.6 : undefined,
          }}
          onClick={() => setMode('privacy')}
        >
          {selectedMode === 'privacy' && checkIcon}
          <Text strong fontSize={18}>
            {t('screen4.privacy.title')}
          </Text>
          <Text fontSize={14} type={'secondary'}>
            {t('screen4.privacy.description')}
          </Text>
        </Block>
      </Flexbox>
      <Text color={cssVar.colorTextSecondary} fontSize={12} style={{ marginTop: 16 }}>
        {managed ? t('screen4.managed') : t('screen4.footerNote')}
      </Text>
      <OnboardingFooterActions
        left={
          <Button
            icon={Undo2Icon}
            style={{ color: cssVar.colorTextDescription }}
            type={'text'}
            onClick={onBack}
          >
            {t('back')}
          </Button>
        }
        right={
          <Button type={'primary'} onClick={onNext}>
            {t('next')}
          </Button>
        }
      />
    </Flexbox>
  );
});

DataModeStep.displayName = 'DataModeStep';

export default DataModeStep;
