'use client';

import { Flexbox, Tag, Text, Tooltip } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PLATFORM_MODULES,
  type PlatformModuleId,
  type PlatformModuleLoadKind,
} from '@/const/platform/modules';

const styles = createStaticStyles(({ css }) => ({
  meta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;

    margin-block-start: 6px;
  `,
  row: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 24px;
    align-items: flex-start;
    justify-content: space-between;

    padding: 16px;
  `,
  text: css`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;

    min-width: 240px;
  `,
  title: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  warning: css`
    color: ${cssVar.colorWarningText};
  `,
}));

/**
 * Load kinds that deserve a chip. `none` never had one, and `onUse` — idle until someone uses
 * the feature — is the benign default rather than a cost: it sat on 11 of 24 rows and told an
 * operator nothing they could act on, which is what made the whole row read as decoration.
 */
const CHIPPED_LOAD_KINDS = new Set<PlatformModuleLoadKind>([
  'perRequest',
  'perMessage',
  'perFetch',
]);

interface CostTag {
  color?: 'error';
  key: string;
  label: string;
}

export interface ModuleRowProps {
  checked: boolean;
  /** Env variable that pinned this module off; disables the switch and explains why. */
  envDisabledBy?: string;
  id: PlatformModuleId;
  onChange: (next: boolean) => void;
  /** Toggled in the draft but only released after a restart. */
  pendingRestart: boolean;
  /** SYSTEM_OPERATE — read-only admins see the state but cannot change it. */
  readOnly: boolean;
  /** Modules this one needs that the draft leaves off. */
  unmetDependencies: PlatformModuleId[];
}

/**
 * One switchable module: what it is, what it costs, and whether anything about the current
 * draft makes it special (env-pinned, pending restart, missing dependency).
 *
 * The cost tags come from the constant table, not from a runtime probe — they are measured
 * once on a reference build so the page can answer "what do I get back" before saving rather
 * than after.
 */
const ModuleRow = memo<ModuleRowProps>(
  ({ checked, envDisabledBy, id, onChange, pendingRestart, readOnly, unmetDependencies }) => {
    const { t } = useTranslation('admin');
    const { cost, kind } = PLATFORM_MODULES[id];
    const locked = Boolean(envDisabledBy) || readOnly;

    const status = envDisabledBy
      ? { color: 'default' as const, label: t('modules.status.env') }
      : pendingRestart
        ? { color: 'warning' as const, label: t('modules.status.pendingRestart') }
        : checked
          ? { color: 'success' as const, label: t('modules.status.running') }
          : { color: 'default' as const, label: t('modules.status.disabled') };

    const control = (
      <Switch checked={checked} disabled={locked} onChange={(next) => onChange(next)} />
    );

    // Every chip here has to answer "what does this cost me?". A module that costs nothing
    // notable gets no row at all — silence is the answer, not a chip that says zero.
    const costTags: CostTag[] = [
      kind === 'restart' ? { key: 'restart', label: t('modules.tags.restart') } : null,
      cost.subprocess ? { key: 'subprocess', label: t('modules.tags.subprocess') } : null,
      cost.loadSensitive
        ? { color: 'error' as const, key: 'loadSensitive', label: t('modules.tags.loadSensitive') }
        : null,
      CHIPPED_LOAD_KINDS.has(cost.loadKind)
        ? { key: 'loadKind', label: t(`modules.tags.loadKind.${cost.loadKind}` as never) }
        : null,
      cost.backgroundJobs > 0
        ? {
            key: 'backgroundJobs',
            label: t('modules.tags.backgroundJobs', { n: cost.backgroundJobs }),
          }
        : null,
      ...cost.externalDeps.map((dep) => ({
        key: `dep-${dep}`,
        // The bare noun ("Redis") is a label; what the operator needs is the obligation.
        label: t('modules.tags.requires', { dep: t(`modules.deps.${dep}` as never) }),
      })),
      // 0 MB is the common case now that routers load lazily, and "≈ 0 MB" on 20 of 24 rows
      // buried the four modules that actually hold memory.
      cost.idleRssMb !== null && cost.idleRssMb > 0
        ? { key: 'idleRss', label: t('modules.tags.idleRss', { mb: cost.idleRssMb }) }
        : null,
    ].filter((tag): tag is CostTag => tag !== null);

    return (
      <div className={styles.row} data-module={id}>
        <div className={styles.text}>
          <div className={styles.title}>
            <Text strong>{t(`modules.items.${id}.title` as never, { defaultValue: id })}</Text>
            <Tag color={status.color} size="small">
              {status.label}
            </Tag>
          </div>
          <Text type="secondary">
            {t(`modules.items.${id}.desc` as never, { defaultValue: '' })}
          </Text>
          {costTags.length > 0 ? (
            <div className={styles.meta}>
              {costTags.map((tag) => (
                <Tag color={tag.color} key={tag.key} size="small">
                  {tag.label}
                </Tag>
              ))}
            </div>
          ) : null}
          {unmetDependencies.length > 0 ? (
            <Text className={styles.warning} style={{ marginBlockStart: 6 }}>
              {t('modules.tags.dependsOn', {
                modules: unmetDependencies
                  .map((dep) => t(`modules.items.${dep}.title` as never, { defaultValue: dep }))
                  .join('、'),
              })}
            </Text>
          ) : null}
        </div>
        <Flexbox horizontal align="center" gap={8}>
          {envDisabledBy ? (
            <Tooltip title={t('modules.envTooltip', { variable: envDisabledBy })}>
              <span>{control}</span>
            </Tooltip>
          ) : (
            control
          )}
        </Flexbox>
      </div>
    );
  },
);

ModuleRow.displayName = 'AdminModuleRow';

export default ModuleRow;
