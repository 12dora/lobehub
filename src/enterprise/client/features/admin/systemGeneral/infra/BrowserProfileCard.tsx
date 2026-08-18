'use client';

import { Alert, CopyButton, Flexbox, Skeleton, Tooltip } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { Fingerprint } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminBrowserProfileSummary } from '@/enterprise/client/services/adminSystem';

import { InfraSettingsCard } from '../InfraSettingsCard';
import { infraSettingsStyles as styles } from '../styles';

export interface BrowserProfileCardProps {
  canOperate: boolean;
  data?: AdminBrowserProfileSummary;
  error: unknown;
  isLoading: boolean;
  onRegenerate: () => Promise<void>;
  onRetry: () => void;
}

const noop = () => undefined;

/**
 * What an operator calls the operating system, from what the profile reports as a UA client
 * hint.
 *
 * Windows reports its `Sec-CH-UA-Platform-Version` on a scale of its own: Windows 11 is 13+,
 * Windows 10 is 1–12, and printing it raw put "Windows 15.0.0" on the card — a release that
 * does not exist. macOS and the rest already report their marketing version, so they are
 * joined verbatim; a profile without a version prints the platform alone rather than a
 * dangling separator.
 */
const formatPlatform = (platform: string, platformVersion: string): string => {
  const major = Number.parseInt(platformVersion, 10);
  if (platform === 'Windows' && Number.isFinite(major))
    return major >= 13 ? 'Windows 11' : 'Windows 10';
  return platformVersion ? `${platform} ${platformVersion}` : platform;
};

/** Installation-wide identity shared by every browser-impersonating transport. */
export const BrowserProfileCard = memo<BrowserProfileCardProps>(
  ({ canOperate, data, error, isLoading, onRegenerate, onRetry }) => {
    const { t } = useTranslation('admin');
    const [regenerating, setRegenerating] = useState(false);

    const generatedAt = useMemo(() => {
      if (!data) return undefined;
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(data.updatedAt);
    }, [data]);

    const requestRegenerate = useCallback(() => {
      confirmModal({
        // The shared cancel label, not a private copy of the same word.
        cancelText: t('cancel', { ns: 'common' }),
        content: t('browserProfile.confirm.description'),
        okButtonProps: { danger: true },
        okText: t('browserProfile.actions.regenerate'),
        title: t('browserProfile.confirm.title'),
        onOk: async () => {
          setRegenerating(true);
          try {
            await onRegenerate();
            toast.success(t('browserProfile.toast.regenerated'));
          } catch (cause) {
            toast.error(t('browserProfile.toast.failed'));
            throw cause;
          } finally {
            setRegenerating(false);
          }
        },
      });
    }, [onRegenerate, t]);

    const banner = error ? (
      <Alert
        showIcon
        description={t('browserProfile.states.errorDescription')}
        message={t('browserProfile.states.error')}
        type="error"
        action={
          <Button size="small" onClick={onRetry}>
            {t('browserProfile.actions.retry')}
          </Button>
        }
      />
    ) : !data && !isLoading ? (
      <Alert showIcon message={t('browserProfile.states.empty')} type="info" />
    ) : undefined;

    return (
      <InfraSettingsCard
        banner={banner}
        canTest={false}
        icon={Fingerprint}
        notice={t('browserProfile.description')}
        probing={false}
        // The same binary the neighbouring infra cards report, through the same tag: this card
        // used to be the only one with an empty header-right, so its title row read as a
        // different component. `unknown` is the presentation the env-sourced cards land on too
        // (已配置), not the 正常 that a probed dependency earns.
        status={data ? 'unknown' : 'disabled'}
        title={t('browserProfile.title')}
        editor={
          isLoading && !data ? <Skeleton active paragraph={{ rows: 5 }} title={false} /> : undefined
        }
        extraActions={
          canOperate ? (
            <Button
              // Regenerating is destructive and irreversible: never offered over a card that
              // has not resolved what it is about to replace.
              disabled={isLoading || Boolean(error)}
              loading={regenerating}
              size="small"
              onClick={requestRegenerate}
            >
              {t(data ? 'browserProfile.actions.regenerate' : 'browserProfile.actions.generate')}
            </Button>
          ) : null
        }
        fields={
          data
            ? [
                {
                  label: t('browserProfile.fields.installationId'),
                  /**
                   * In full, and copyable. It is not a secret — it identifies this deployment
                   * to upstream and is what an operator quotes in a support thread — and the
                   * 8-char mask it used to carry could neither be read nor copied.
                   */
                  value: (
                    <Flexbox horizontal align={'center'} gap={4} justify={'flex-end'}>
                      <span className={styles.code}>{data.installationId}</span>
                      <CopyButton content={data.installationId} size={'small'} />
                    </Flexbox>
                  ),
                },
                {
                  label: t('browserProfile.fields.chrome'),
                  /**
                   * The version, once. The curl-impersonate target name next to it repeated the
                   * same major version in jargon; it stays reachable on hover for the operator
                   * who is diagnosing a transport, and off the card for everyone else.
                   */
                  value: (
                    <Tooltip
                      title={t('browserProfile.values.impersonateProfile', {
                        profile: data.impersonateProfile,
                      })}
                    >
                      <span>{data.chromeVersion}</span>
                    </Tooltip>
                  ),
                },
                {
                  label: t('browserProfile.fields.platform'),
                  value: `${formatPlatform(data.platform, data.platformVersion)} · ${data.arch}`,
                },
                {
                  label: t('browserProfile.fields.localeTimezone'),
                  value: `${data.locale} · ${data.timezone}`,
                },
                {
                  label: t('browserProfile.fields.screen'),
                  value: t('browserProfile.values.screen', data.screen),
                },
                {
                  label: t('browserProfile.fields.compute'),
                  value: t('browserProfile.values.compute', {
                    cores: data.cores,
                    memory: data.memoryGiB,
                  }),
                },
                {
                  label: t('browserProfile.fields.generatedAt'),
                  value: generatedAt,
                },
              ]
            : undefined
        }
        onTest={noop}
      />
    );
  },
);

BrowserProfileCard.displayName = 'AdminBrowserProfileCard';
