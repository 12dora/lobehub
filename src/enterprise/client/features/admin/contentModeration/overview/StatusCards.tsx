'use client';

import { Icon, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { LucideIcon } from 'lucide-react';
import { Database, Gauge, ShieldAlert, ShieldBan, TrendingDown } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ContentModerationOverview } from '@/types/platform/contentModeration';

import {
  CLASSIFIER_HEALTH_TAG_COLOR,
  classifierHealthLevel,
  classifierKindLabel,
  formatLatency,
  formatPercent,
  modeLabel,
} from '../format';
import ManageGuard from '../ManageGuard';
import { moderationStyles as styles } from '../styles';

interface StatusCardProps {
  action?: ReactNode;
  fields: { label: string; value: ReactNode }[];
  icon: LucideIcon;
  tag?: { color?: string; label: string };
  title: string;
}

const StatusCard = memo<StatusCardProps>(({ action, fields, icon, tag, title }) => (
  <section className={styles.card}>
    <div className={styles.cardHeader}>
      <span style={{ alignItems: 'center', display: 'flex', gap: 8 }}>
        <Icon icon={icon} size={16} />
        <Text strong>{title}</Text>
      </span>
      {tag ? (
        <Tag color={tag.color} size="small">
          {tag.label}
        </Tag>
      ) : null}
    </div>
    <div className={styles.cardBody}>
      {fields.map((field) => (
        <div className={styles.fieldRow} key={field.label}>
          <Text className={styles.fieldLabel} type="secondary">
            {field.label}
          </Text>
          <Text className={styles.fieldValue}>{field.value ?? '—'}</Text>
        </div>
      ))}
    </div>
    {action ? <div className={styles.cardFooter}>{action}</div> : null}
  </section>
));
StatusCard.displayName = 'ModerationStatusCard';

export interface StatusCardsProps {
  canManage: boolean;
  clearing: boolean;
  data: ContentModerationOverview;
  onClearCache: () => void;
  onOpenSettings: () => void;
}

const MODE_TAG_COLOR: Record<string, string | undefined> = {
  enforce: 'success',
  observe: 'warning',
  off: undefined,
};

/**
 * The five status cards of 概况 (design §6.1). Every card answers one question an
 * operator asks before trusting the numbers below: is it on, what decides, what rules,
 * where do downgrades go, and does it ban.
 */
const StatusCards = memo<StatusCardsProps>(
  ({ canManage, clearing, data, onClearCache, onOpenSettings }) => {
    const { t } = useTranslation('admin');

    const health = classifierHealthLevel(data.classifier.kind, data.classifier.health);
    const clearButton = (
      <Button
        disabled={!canManage || clearing}
        loading={clearing}
        size="small"
        onClick={onClearCache}
      >
        {t('contentModeration.overview.clearCache')}
      </Button>
    );

    return (
      <div className={styles.cardGrid}>
        <StatusCard
          icon={Gauge}
          tag={{ color: MODE_TAG_COLOR[data.mode], label: modeLabel(t, data.mode) }}
          title={t('contentModeration.overview.modeTitle')}
          action={
            <Button size="small" onClick={onOpenSettings}>
              {t('contentModeration.overview.openSettings')}
            </Button>
          }
          fields={[
            {
              label: t('contentModeration.overview.modeField'),
              value: t(`contentModeration.mode.${data.mode}Desc` as never),
            },
          ]}
        />

        <StatusCard
          icon={ShieldAlert}
          title={t('contentModeration.overview.classifierTitle')}
          fields={[
            {
              label: t('contentModeration.overview.classifierKind'),
              value: classifierKindLabel(t, data.classifier.kind),
            },
            {
              label: t('contentModeration.overview.classifierTarget'),
              value: data.classifier.label ?? '—',
            },
            {
              label: t('contentModeration.overview.classifierHealth'),
              value: data.classifier.health
                ? t('contentModeration.overview.healthDetail', {
                    latency: formatLatency(data.classifier.health.avgLatencyMs),
                    rate: formatPercent(data.classifier.health.successRate),
                    samples: data.classifier.health.sampleSize,
                  })
                : t('contentModeration.overview.healthNoSamples'),
            },
          ]}
          tag={{
            color: CLASSIFIER_HEALTH_TAG_COLOR[health],
            label: t(`contentModeration.overview.health.${health}` as never),
          }}
        />

        <StatusCard
          action={<ManageGuard allowed={canManage}>{clearButton}</ManageGuard>}
          icon={Database}
          title={t('contentModeration.overview.rulesTitle')}
          fields={[
            {
              label: t('contentModeration.overview.keywordCount'),
              value: t('contentModeration.overview.rulesValue', { count: data.keywordRuleCount }),
            },
            {
              label: t('contentModeration.overview.cacheCount'),
              value: t('contentModeration.overview.cacheValue', { count: data.decisionCacheCount }),
            },
          ]}
        />

        <StatusCard
          icon={TrendingDown}
          title={t('contentModeration.overview.downgradeTitle')}
          fields={[
            {
              label: t('contentModeration.overview.downgradeTarget'),
              value: data.downgrade
                ? `${data.downgrade.provider} / ${data.downgrade.model}`
                : t('contentModeration.overview.downgradeMissing'),
            },
          ]}
          tag={
            data.downgrade
              ? undefined
              : { color: 'warning', label: t('contentModeration.overview.downgradeMissingTag') }
          }
        />

        <StatusCard
          icon={ShieldBan}
          title={t('contentModeration.overview.autoBanTitle')}
          fields={[
            {
              label: t('contentModeration.overview.autoBanRule'),
              value: data.autoBan.enabled
                ? t('contentModeration.overview.autoBanValue', {
                    days: data.autoBan.windowDays,
                    threshold: data.autoBan.threshold,
                  })
                : t('contentModeration.overview.autoBanOff'),
            },
          ]}
          tag={{
            color: data.autoBan.enabled ? 'warning' : undefined,
            label: data.autoBan.enabled
              ? t('contentModeration.overview.enabled')
              : t('contentModeration.overview.disabled'),
          }}
        />
      </div>
    );
  },
);

StatusCards.displayName = 'ModerationStatusCards';

export default StatusCards;
