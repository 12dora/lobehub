'use client';

import { Tabs } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import AgentTemplateListPage from '../agentTemplates/AgentTemplateListPage';
import AdminPageTemplate from '../primitives/AdminPageTemplate';
import TaskTemplateListPage from '../taskTemplates/TaskTemplateListPage';

type TemplatesTab = 'agents' | 'tasks';

/**
 * "模板管理 / Template management" — one nav surface for the two template catalogs the
 * `taskTemplates` module owns: 任务模板 (scheduled-task recommendations) and 助理模板
 * (create-agent example cards). Both sub-pages render `embedded`, so they drop their own <h1>
 * (the tab already names them) while keeping their own actions in the inner header.
 * The active tab rides in `?tab=` for deep links, mirroring SecurityAuthPage.
 */
const TemplatesManagementPage = memo(() => {
  const { t } = useTranslation('admin');
  const [params, setParams] = useSearchParams();

  const tabs = useMemo(
    () => [
      { key: 'tasks' as const, label: t('templates.tabs.tasks') },
      { key: 'agents' as const, label: t('templates.tabs.agents') },
    ],
    [t],
  );

  // 任务模板 stays the default: `/admin/ai/task-templates` was its page before the merge.
  const tab: TemplatesTab = params.get('tab') === 'agents' ? 'agents' : 'tasks';

  return (
    <AdminPageTemplate
      description={t('page.templates.desc')}
      title={t('nav.templates')}
      toolbar={
        <Tabs
          activeKey={tab}
          items={tabs}
          onChange={(key) => {
            const next = new URLSearchParams(params);
            next.set('tab', key);
            setParams(next, { replace: true });
          }}
        />
      }
    >
      {tab === 'agents' ? <AgentTemplateListPage embedded /> : <TaskTemplateListPage embedded />}
    </AdminPageTemplate>
  );
});

TemplatesManagementPage.displayName = 'TemplatesManagementPage';

export default TemplatesManagementPage;
