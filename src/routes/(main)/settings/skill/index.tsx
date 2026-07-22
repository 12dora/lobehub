'use client';

import isEqual from 'fast-deep-equal';
import { memo, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useAdminToolScope } from '@/features/AdminToolScope';
import { ManagedResourceBoundary, ManagedResourceNotice } from '@/features/ManagedResources';
import NavHeader from '@/features/NavHeader';
import { masterDetailSurfaceStyles } from '@/features/SettingsCatalogSurface';
import { useToolStore } from '@/store/tool';
import { agentSkillsSelectors, builtinToolSelectors } from '@/store/tool/selectors';

import LeftPanel from './features/LeftPanel';
import SkillDetail, { type ToolDetailType } from './features/SkillDetail';
import { type SkillViewMode } from './features/SkillList';
import { resolveInitialToolSelection, type SelectedTool } from './initialSelection';

const styles = masterDetailSurfaceStyles;

interface ToolSettingsProps {
  /** Organization-managed connector mode keeps only per-user OAuth binding. */
  managed?: boolean;
  /**
   * Which surface to manage. Fixed per-route now that skills and connectors
   * each own a dedicated settings page (`/settings/skill` and
   * `/settings/connector`) instead of sharing one tab-switched page.
   */
  viewMode: SkillViewMode;
}

/**
 * Canonical settings surface for skills/connectors. Admin AI pages compose the
 * same MasterDetailSettingsSurface + catalog list/detail chrome with an
 * injectable admin datasource (admin.skills / admin.connectors).
 */
export const ToolSettings = memo<ToolSettingsProps>(({ viewMode, managed = false }) => {
  // Under the admin panel (AdminToolScopeProvider) the exact same surface is
  // rendered with an org-global datasource; the settings NavHeader is replaced
  // by the admin layout chrome.
  const adminScope = useAdminToolScope();
  const [searchParams, setSearchParams] = useSearchParams();
  const querySkillIdentifier = searchParams.get('skill');
  const [selected, setSelected] = useState<SelectedTool | null>(null);

  const builtinTools = useToolStore((s) => s.builtinTools, isEqual);
  const builtinSkills = useToolStore((s) => s.builtinSkills, isEqual);
  const marketAgentSkills = useToolStore(agentSkillsSelectors.getMarketAgentSkills, isEqual);
  const userAgentSkills = useToolStore(agentSkillsSelectors.getUserAgentSkills, isEqual);
  const platformSkillCatalog = useToolStore(agentSkillsSelectors.getPlatformSkillCatalog, isEqual);
  const platformSkillRuntimeStatus = useToolStore((s) => s.platformSkillRuntimeStatus);
  const installedBuiltinIds = useToolStore(
    (s) => builtinToolSelectors.installedAllMetaList(s).map((tool) => tool.identifier),
    isEqual,
  );

  useEffect(() => {
    if (!managed || viewMode !== 'skill') return;
    if (platformSkillRuntimeStatus !== 'ready') return;
    const skills = platformSkillCatalog?.skills ?? [];
    const requested = querySkillIdentifier
      ? skills.find((skill) => skill.skillKey === querySkillIdentifier)
      : undefined;
    const initial = resolveInitialToolSelection({
      builtinSkills,
      builtinTools,
      installedBuiltinIds,
      managed,
      platformSkills: skills,
      viewMode,
    });
    const next = requested
      ? { identifier: requested.skillKey, type: 'platform-skill' as const }
      : initial;
    setSelected(next);

    const nextParams = new URLSearchParams(searchParams);
    if (next) nextParams.set('skill', next.identifier);
    else nextParams.delete('skill');
    if (nextParams.toString() !== searchParams.toString()) {
      setSearchParams(nextParams, { replace: true });
    }
  }, [
    builtinTools,
    builtinSkills,
    installedBuiltinIds,
    managed,
    platformSkillCatalog,
    platformSkillRuntimeStatus,
    querySkillIdentifier,
    searchParams,
    setSearchParams,
    viewMode,
  ]);

  useEffect(() => {
    if (managed) return;
    if (selected) return;
    if (viewMode === 'skill' && querySkillIdentifier) return;
    const initial = resolveInitialToolSelection({
      builtinSkills,
      builtinTools,
      installedBuiltinIds,
      managed,
      platformSkills: platformSkillCatalog?.skills,
      viewMode,
    });
    if (initial) setSelected(initial);
  }, [
    builtinTools,
    builtinSkills,
    installedBuiltinIds,
    managed,
    platformSkillCatalog,
    querySkillIdentifier,
    selected,
    viewMode,
  ]);

  useEffect(() => {
    if (managed) return;
    if (viewMode !== 'skill' || !querySkillIdentifier) return;

    const skill = [...marketAgentSkills, ...userAgentSkills].find(
      (item) => item.identifier === querySkillIdentifier,
    );
    if (skill) setSelected({ identifier: skill.id, type: 'agent-skill' });
  }, [managed, marketAgentSkills, querySkillIdentifier, userAgentSkills, viewMode]);

  const handleSelect = (identifier: string, type: ToolDetailType) => {
    setSelected({ identifier, type });
    if (managed && type === 'platform-skill') {
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('skill', identifier);
      setSearchParams(nextParams);
    }
  };

  return (
    <>
      {!adminScope && <NavHeader />}
      {adminScope?.connectorNotice ? (
        <div style={{ padding: '12px 16px 0' }}>{adminScope.connectorNotice}</div>
      ) : null}
      {managed ? (
        <div style={{ padding: '12px 16px 0' }}>
          <ManagedResourceNotice
            inline
            resource={viewMode === 'connector' ? 'connectors' : 'skills'}
          />
        </div>
      ) : null}
      <div className={styles.root}>
        <LeftPanel
          managed={managed}
          selectedIdentifier={selected?.identifier}
          viewMode={viewMode}
          onDeleteSelected={() => setSelected(null)}
          onSelect={handleSelect}
        />

        {selected && (
          <div className={styles.detail}>
            <SkillDetail
              identifier={selected.identifier}
              managed={managed}
              type={selected.type}
              onDelete={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </>
  );
});

ToolSettings.displayName = 'ToolSettings';

/**
 * Personal + workspace skill settings entry.
 * Platform-managed skills are blocked here (and again by SettingsContent for
 * personal tabs) so deep links cannot keep a configuration surface open.
 * Published skill consumption in agent runtime is unaffected.
 */
const Page = memo(() => (
  <ManagedResourceBoundary resource="skills">
    <ToolSettings managed={false} viewMode="skill" />
  </ManagedResourceBoundary>
));

Page.displayName = 'SkillSettings';

export default Page;
