'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import AdminPageTemplate from '@/enterprise/client/features/admin/primitives/AdminPageTemplate';
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
  const { t } = useTranslation('admin');
  const scope = useAdminGlobalToolScope('skill');

  return (
    <AdminPageTemplate fullHeight description={t('page.aiSkills.desc')} title={t('nav.aiSkills')}>
      <AdminToolScopeProvider value={scope}>
        <ToolSettings managed={false} viewMode="skill" />
      </AdminToolScopeProvider>
    </AdminPageTemplate>
  );
});

SkillSettingsPage.displayName = 'AdminSkillSettingsPage';

export default SkillSettingsPage;
