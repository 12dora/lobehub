'use client';

import { type IconProps } from '@lobehub/ui';
import { Block, Button, Flexbox, Icon, Text } from '@lobehub/ui';
import { TypewriterEffect } from '@lobehub/ui/awesome';
import { Switch } from '@lobehub/ui/base-ui';
import { LoadingDots } from '@lobehub/ui/chat';
import { Steps } from 'antd';
import { cssVar } from 'antd-style';
import { BrainIcon, HeartHandshakeIcon, PencilRulerIcon, ShieldCheck } from 'lucide-react';
import { memo, useCallback, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { ProductLogo } from '@/components/Branding';
import { PRIVACY_URL, TERMS_URL } from '@/const/url';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { resolveManagedBoolean } from '@/features/PlatformSettingSourceBadge/managedControlValue';
import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { useDefaultInboxDisplayName } from '@/hooks/useDefaultInboxDisplayName';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors } from '@/store/user/selectors';

interface TelemetryStepProps {
  onNext: () => void;
}

const TelemetryStep = memo<TelemetryStepProps>(({ onNext }) => {
  const { t, i18n } = useTranslation('onboarding');
  const locale = i18n.language;
  const branding = useBranding();
  const storedTelemetry = useUserStore(userGeneralSettingsSelectors.telemetry);
  const [check, setCheck] = useState(storedTelemetry);
  const [isNavigating, setIsNavigating] = useState(false);
  const inboxDisplayName = useDefaultInboxDisplayName();
  const isNavigatingRef = useRef(false);
  const updateGeneralConfig = useUserStore((s) => s.updateGeneralConfig);
  const telemetryMeta = usePlatformSettingMeta('general.telemetry');

  // `locked` is fail-closed: it is also true while the policy is loading or errored, so the
  // wizard never lets someone opt in to a value the platform is about to overrule.
  const managed = telemetryMeta.locked;
  // Read the enforced value from the policy, not the store: the store can still hold the
  // pre-policy value, which would render a disabled switch that lies about what is sent.
  const checked = resolveManagedBoolean(telemetryMeta, check);

  const handleChoice = useCallback(
    (enabled: boolean) => {
      if (isNavigatingRef.current) return;
      isNavigatingRef.current = true;
      setIsNavigating(true);
      if (!managed) updateGeneralConfig({ telemetry: enabled });
      onNext();
    },
    [managed, updateGeneralConfig, onNext],
  );

  // eslint-disable-next-line @eslint-react/no-nested-component-definitions
  const IconAvatar = useCallback(({ icon }: { icon: IconProps['icon'] }) => {
    return (
      <Block
        shadow
        align="center"
        height={32}
        justify="center"
        padding={4}
        variant="outlined"
        width={32}
      >
        <Icon color={cssVar.colorTextDescription} icon={icon} size={16} />
      </Block>
    );
  }, []);

  return (
    <Flexbox gap={16}>
      <ProductLogo size={64} />
      <Flexbox style={{ marginBottom: 16 }}>
        <Text as={'h1'} fontSize={28} weight={'bold'}>
          <TypewriterEffect
            cursorCharacter={<LoadingDots size={28} variant={'pulse'} />}
            cursorFade={false}
            deletePauseDuration={1000}
            deletingSpeed={32}
            hideCursorWhileTyping={'afterTyping'}
            key={locale}
            pauseDuration={16_000}
            typingSpeed={64}
            sentences={[
              t('telemetry.title', { name: inboxDisplayName }),
              t('telemetry.title2'),
              t('telemetry.title3'),
            ]}
          />
        </Text>
        <Text as={'p'}>{t('telemetry.desc')}</Text>
      </Flexbox>
      <Steps
        current={null as any}
        direction={'vertical'}
        items={[
          {
            description: (
              <Text as={'p'} color={cssVar.colorTextSecondary} style={{ marginBottom: 16 }}>
                {t('telemetry.rows.create.desc')}
              </Text>
            ),
            icon: <IconAvatar icon={PencilRulerIcon} />,
            title: (
              <Text as={'h2'} fontSize={16}>
                {t('telemetry.rows.create.title')}
              </Text>
            ),
          },
          {
            description: (
              <Text as={'p'} color={cssVar.colorTextSecondary} style={{ marginBottom: 16 }}>
                {t('telemetry.rows.collaborate.desc')}
              </Text>
            ),
            icon: <IconAvatar icon={HeartHandshakeIcon} />,
            title: (
              <Text as={'h2'} fontSize={16}>
                {t('telemetry.rows.collaborate.title')}
              </Text>
            ),
          },
          {
            description: (
              <Text as={'p'} color={cssVar.colorTextSecondary}>
                {t('telemetry.rows.evolve.desc')}
              </Text>
            ),
            icon: <IconAvatar icon={BrainIcon} />,
            title: (
              <Text as={'h2'} fontSize={16}>
                {t('telemetry.rows.evolve.title')}
              </Text>
            ),
          },
        ]}
      />
      {!telemetryMeta.hidden && (
        <Flexbox gap={8}>
          <Text as={'p'} color={cssVar.colorTextSecondary}>
            {t('telemetry.rows.privacy.desc', { appName: branding.name })}
          </Text>
          <Flexbox horizontal align="center" gap={8}>
            <Switch
              checked={checked}
              disabled={managed}
              size={'small'}
              onChange={(v) => setCheck(v)}
            />
            <Text fontSize={12} type={checked ? undefined : 'secondary'}>
              {t('telemetry.rows.privacy.title', { appName: branding.name })}
            </Text>
          </Flexbox>
          {managed && (
            <Text fontSize={12} type={'secondary'}>
              {t('telemetry.rows.managed')}
            </Text>
          )}
        </Flexbox>
      )}
      <Button
        disabled={isNavigating}
        size={'large'}
        type="primary"
        style={{
          marginBlock: 8,
          maxWidth: 240,
        }}
        onClick={() => handleChoice(checked)}
      >
        {t('telemetry.next')}
      </Button>
      {checked && (
        <Block horizontal align="flex-start" gap={8} variant={'borderless'}>
          <Icon
            icon={ShieldCheck}
            size={16}
            style={{ color: cssVar.colorSuccess, flexShrink: 0 }}
          />
          <Text fontSize={12} type="secondary">
            <Trans
              i18nKey={'telemetry.agreement'}
              ns={'onboarding'}
              components={{
                privacy: (
                  <a
                    href={PRIVACY_URL}
                    style={{ color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    {t('telemetry.terms')}
                  </a>
                ),
                terms: (
                  <a
                    href={TERMS_URL}
                    style={{ color: 'inherit', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    {t('telemetry.privacy')}
                  </a>
                ),
              }}
            />
          </Text>
        </Block>
      )}
    </Flexbox>
  );
});

TelemetryStep.displayName = 'TelemetryStep';

export default TelemetryStep;
