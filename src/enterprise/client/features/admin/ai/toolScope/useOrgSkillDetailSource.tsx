'use client';

import type { SkillResourceTreeNode } from '@lobechat/types';
import { useCallback } from 'react';

import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import type { AdminOrgSkillDetailData } from '@/features/AdminToolScope';
import { useClientDataSWR } from '@/libs/swr';

import { isInitialSwrLoading } from './toolScopeSection';

/** SKILL.md always heads the tree; bundled resources follow under their own paths. */
const buildResourceTree = (
  content: string,
  resources: { content?: string; path: string }[],
): SkillResourceTreeNode[] => [
  { content, name: 'SKILL.md', path: 'SKILL.md', type: 'file' },
  ...resources
    .filter((resource) => resource.path !== 'SKILL.md')
    .map((resource): SkillResourceTreeNode => ({
      content: resource.content,
      name: resource.path.split('/').findLast(Boolean) || resource.path,
      path: resource.path,
      type: 'file',
    })),
];

const fetchOrgSkillDetail = async (skillId: string): Promise<AdminOrgSkillDetailData> => {
  const detail = await adminSkillsService.get({ id: skillId });
  const summary = detail.publishedVersion ?? detail.latestVersion;
  const version = summary
    ? await adminSkillsService.getVersion({ skillId, versionId: summary.id })
    : null;
  const content = version?.content ?? '';
  const resources = (version?.resources ?? []) as {
    content?: string;
    path: string;
  }[];
  return {
    resourceTree: buildResourceTree(content, resources),
    skillDetail: {
      content,
      description: detail.draft.description,
      manifest: (version?.manifest ?? null) as Record<string, any> | null,
      name: detail.draft.displayName,
      updatedAt: (version as { createdAt?: string } | null)?.createdAt ?? new Date(0),
    },
  };
};

/** Org skill detail (AgentSkillDetail parity), injected into the UI as a datasource hook. */
export const useOrgSkillDetailSource = () =>
  useCallback((skillId: string) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable hook impl injected as datasource
    const swr = useClientDataSWR(
      ['admin-tool-scope/skill-detail', skillId],
      async (): Promise<AdminOrgSkillDetailData> => fetchOrgSkillDetail(skillId),
      { revalidateOnFocus: false },
    );
    return { data: swr.data, isLoading: isInitialSwrLoading(swr) };
  }, []);
