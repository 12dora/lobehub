'use client';

import { Flexbox, Tag, Text, Tooltip } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_MODULES, type PlatformModuleId } from '@/const/platform/modules';

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
          <div className={styles.meta}>
            {kind === 'restart' ? <Tag size="small">{t('modules.tags.restart')}</Tag> : null}
            {cost.subprocess ? <Tag size="small">{t('modules.tags.subprocess')}</Tag> : null}
            {cost.loadSensitive ? (
              <Tag color="error" size="small">
                {t('modules.tags.loadSensitive')}
              </Tag>
            ) : null}
            {cost.loadKind === 'none' ? null : (
              <Tag size="small">{t(`modules.tags.loadKind.${cost.loadKind}` as never)}</Tag>
            )}
            {cost.backgroundJobs > 0 ? (
              <Tag size="small">{t('modules.tags.backgroundJobs', { n: cost.backgroundJobs })}</Tag>
            ) : null}
            {cost.externalDeps.map((dep) => (
              <Tag key={dep} size="small">
                {t(`modules.deps.${dep}` as never)}
              </Tag>
            ))}
            {cost.idleRssMb === null ? null : (
              <Tag size="small">{t('modules.tags.idleRss', { mb: cost.idleRssMb })}</Tag>
            )}
          </div>
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
