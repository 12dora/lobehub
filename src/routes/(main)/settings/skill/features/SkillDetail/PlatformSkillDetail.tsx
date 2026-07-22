'use client';

import { getPluginMode } from '@lobechat/types';
import { Flexbox, Text } from '@lobehub/ui';
import { Switch, toast } from '@lobehub/ui/base-ui';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import {
  getPublishedSkillToggleMode,
  isPublishedSkillEnabled,
  usePublishedSkillCatalog,
} from '@/enterprise/client/features/skills';
import { CatalogDetailChrome, catalogDetailStyles } from '@/features/SettingsCatalogSurface';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import { useToolStore } from '@/store/tool';

interface PlatformSkillDetailProps {
  skillKey: string;
}

/**
 * User managed skill detail — per-agent enable toggle against the published
 * platform.skills catalog. Shares CatalogDetailChrome with admin detail panels.
 */
const PlatformSkillDetail = memo<PlatformSkillDetailProps>(({ skillKey }) => {
  const { t } = useTranslation('setting');
  const runtimeManaged = useToolStore((state) => state.platformSkillRuntimeManaged);
  const runtimeStatus = useToolStore((state) => state.platformSkillRuntimeStatus);
  const catalog = usePublishedSkillCatalog(runtimeManaged);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [failedNextEnabled, setFailedNextEnabled] = useState<boolean | null>(null);
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
    return <div className={catalogDetailStyles.body}>{t('platformSkills.detail.notFound')}</div>;
  }

  const toggle = async (nextEnabled: boolean) => {
    const nextMode = getPublishedSkillToggleMode(skill.distribution, nextEnabled);
    if (!nextMode || !config || !agentId) return;
    setSaving(true);
    setSaveError(null);
    setFailedNextEnabled(null);
    try {
      await setPluginModeById(agentId, skill.skillKey, nextMode);
    } catch (error) {
      setSaveError(error instanceof Error ? error : new Error(String(error)));
      setFailedNextEnabled(nextEnabled);
      toast.error(t('platformSkills.detail.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <CatalogDetailChrome
      description={skill.description || t('platformSkills.detail.noDescription')}
      title={skill.displayName}
    >
      {catalog.error ? (
        <AsyncError error={catalog.error} variant="block" onRetry={() => void catalog.mutate()} />
      ) : null}
      {saveError && failedNextEnabled !== null ? (
        <AsyncError
          error={saveError}
          variant="block"
          onRetry={() => void toggle(failedNextEnabled)}
        />
      ) : null}
      <section className={catalogDetailStyles.card}>
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
    </CatalogDetailChrome>
  );
});

PlatformSkillDetail.displayName = 'PlatformSkillDetail';

export default PlatformSkillDetail;
