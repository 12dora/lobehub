'use client';

import { memo } from 'react';

import { AdminToolScopeProvider } from '@/features/AdminToolScope';
import { ToolSettings } from '@/routes/(main)/settings/skill';

import { useAdminGlobalToolScope } from '../toolScope/useAdminGlobalToolScope';

/**
 * Admin `/admin/ai/skills`: byte-identical to the user `/settings/skill`
 * surface (built-in skills, 3 import flows, skill store, detail panels) —
 * rendered against the org-global datasource so every action applies to the
 * whole organization via admin.skills applyImmediate.
 */
const SkillSettingsPage = memo(() => {
  const scope = useAdminGlobalToolScope('skill');

  return (
    <AdminToolScopeProvider value={scope}>
      <ToolSettings managed={false} viewMode="skill" />
    </AdminToolScopeProvider>
  );
});

SkillSettingsPage.displayName = 'AdminSkillSettingsPage';

export default SkillSettingsPage;
