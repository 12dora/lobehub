'use client';

import { Text } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { PlatformModuleId, PlatformModuleStateMap } from '@/const/platform/modules';

import { groupModuleIds, unmetDependencies } from './moduleDraft';
import ModuleRow from './ModuleRow';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    display: flex;
    flex-direction: column;

    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  coreRow: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 10px;
    padding-inline: 16px;
  `,
  divider: css`
    height: 1px;
    margin: 0;
    border: none;
    background: ${cssVar.colorBorderSecondary};
  `,
  group: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  root: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
  `,
  summary: css`
    cursor: pointer;
    padding-block: 12px;
    padding-inline: 16px;
    font-weight: 500;
  `,
}));

export interface ModuleGroupListProps {
  draft: PlatformModuleStateMap;
  envDisabledBy: Partial<Record<PlatformModuleId, string>>;
  onToggle: (id: PlatformModuleId, next: boolean) => void;
  pendingRestart: PlatformModuleId[];
  readOnly: boolean;
}

/** Platform management first — that is what an operator came here to size down. */
const ModuleGroupList = memo<ModuleGroupListProps>(
  ({ draft, envDisabledBy, onToggle, pendingRestart, readOnly }) => {
    const { t } = useTranslation('admin');
    const groups = useMemo(() => groupModuleIds(), []);
    const pending = useMemo(() => new Set(pendingRestart), [pendingRestart]);

    const renderGroup = (titleKey: string, ids: PlatformModuleId[]) => (
      <section className={styles.group}>
        <Text strong>{t(titleKey as never)}</Text>
        <div className={styles.card}>
          {ids.map((id, index) => (
            <div key={id}>
              {index === 0 ? null : <hr className={styles.divider} />}
              <ModuleRow
                checked={draft[id]}
                envDisabledBy={envDisabledBy[id]}
                id={id}
                pendingRestart={pending.has(id)}
                readOnly={readOnly}
                unmetDependencies={unmetDependencies(id, draft)}
                onChange={(next) => onToggle(id, next)}
              />
            </div>
          ))}
        </div>
      </section>
    );

    return (
      <div className={styles.root}>
        {renderGroup('modules.groups.fork', groups.fork)}
        {renderGroup('modules.groups.upstream', groups.upstream)}
      </div>
    );
  },
);

ModuleGroupList.displayName = 'AdminModuleGroupList';

/** Areas that are not modules at all — listed so their absence from the switches is not a mystery. */
const CORE_AREA_KEYS = ['chat', 'users', 'auth', 'adminShell'] as const;

export const CoreModulesFooter = memo(() => {
  const { t } = useTranslation('admin');

  return (
    <details className={styles.card}>
      <summary className={styles.summary}>{t('modules.core.title')}</summary>
      <hr className={styles.divider} />
      {CORE_AREA_KEYS.map((key) => (
        <div className={styles.coreRow} key={key}>
          <Text type="secondary">{t(`modules.core.items.${key}` as never)}</Text>
          <Switch checked disabled />
        </div>
      ))}
    </details>
  );
});

CoreModulesFooter.displayName = 'AdminCoreModulesFooter';

export default ModuleGroupList;
