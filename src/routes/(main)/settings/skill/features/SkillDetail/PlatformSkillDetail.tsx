'use client';

import { getPluginMode } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import {
  getPublishedSkillToggleMode,
  isPublishedSkillEnabled,
  usePublishedSkillCatalog,
} from '@/enterprise/client/features/skills';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import { useToolStore } from '@/store/tool';

const styles = createStaticStyles(({ css, cssVar }) => ({
  body: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
  `,
  card: css`
    display: grid;
    grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
    gap: 10px 16px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
  `,
  description: css`
    line-height: 1.6;
    color: ${cssVar.colorTextSecondary};
  `,
  header: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding-block: 20px 16px;
    padding-inline: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
}));

interface PlatformSkillDetailProps {
  skillKey: string;
}

const PlatformSkillDetail = memo<PlatformSkillDetailProps>(({ skillKey }) => {
  const { t } = useTranslation('setting');
  const runtimeManaged = useToolStore((state) => state.platformSkillRuntimeManaged);
  const runtimeStatus = useToolStore((state) => state.platformSkillRuntimeStatus);
  const catalog = usePublishedSkillCatalog(runtimeManaged);
  const [saving, setSaving] = useState(false);
  const config = useAgentStore(agentSelectors.currentAgentConfig);
  const agentId = useAgentStore((state) => state.activeAgentId);
  const setPluginModeById = useAgentStore((state) => state.setPluginModeById);
  const skill = catalog.data?.skills.find((item) => item.skillKey === skillKey);
  const mode = getPluginMode(config?.plugins, skillKey);
  const enabled = skill ? isPublishedSkillEnabled(skill.distribution, mode) : false;

  if (runtimeStatus === 'error' || (catalog.error && !catalog.data)) {
    return (
      <AsyncError error={catalog.error} variant="page" onRetry={() => void catalog.mutate()} />
    );
  }
  if (runtimeStatus === 'loading' || (catalog.isLoading && !catalog.data)) {
    return <Loading debugId="Settings > Skill > Published detail" />;
  }
  if (runtimeStatus !== 'ready' || !skill) {
    return <div className={styles.body}>{t('platformSkills.detail.notFound')}</div>;
  }

  const toggle = async (nextEnabled: boolean) => {
    const nextMode = getPublishedSkillToggleMode(skill.distribution, nextEnabled);
    if (!nextMode || !config || !agentId) return;
    setSaving(true);
    try {
      await setPluginModeById(agentId, skill.skillKey, nextMode);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <header className={styles.header}>
        <Text strong as="h2">
          {skill.displayName}
        </Text>
        <span className={styles.description}>
          {skill.description || t('platformSkills.detail.noDescription')}
        </span>
      </header>
      <main className={styles.body}>
        {catalog.error ? (
          <AsyncError error={catalog.error} variant="block" onRetry={() => void catalog.mutate()} />
        ) : null}
        <section className={styles.card}>
          <Text type="secondary">{t('platformSkills.detail.source')}</Text>
          <Text>{t(`platformSkills.source.${skill.source}` as never)}</Text>
          <Text type="secondary">{t('platformSkills.detail.distribution')}</Text>
          <Text>{t(`platformSkills.distribution.${skill.distribution}` as never)}</Text>
          <Text type="secondary">{t('platformSkills.detail.version')}</Text>
          <Text>{skill.version}</Text>
          <Text type="secondary">{t('platformSkills.detail.checksum')}</Text>
          <Text code>{skill.checksum}</Text>
          <Text type="secondary">{t('platformSkills.detail.use')}</Text>
          <Flexbox horizontal align="center" gap={8}>
            <Switch
              checked={enabled}
              disabled={skill.distribution === 'mandatory' || !config || saving}
              onChange={(checked) => void toggle(checked)}
            />
            <Text type="secondary">
              {skill.distribution === 'mandatory'
                ? t('platformSkills.detail.mandatoryManaged')
                : t('platformSkills.detail.useHint')}
            </Text>
          </Flexbox>
        </section>
      </main>
    </>
  );
});

PlatformSkillDetail.displayName = 'PlatformSkillDetail';

export default PlatformSkillDetail;
