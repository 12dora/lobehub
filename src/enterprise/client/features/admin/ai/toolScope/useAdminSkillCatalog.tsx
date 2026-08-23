'use client';

import { builtinSkills as bundledBuiltinSkills } from '@lobechat/builtin-skills';
import type { SkillListItem } from '@lobechat/types';
import { useCallback, useMemo } from 'react';

import { useClientDataSWR } from '@/libs/swr';

import { refreshAdminSkillLists } from '../../skills/hooks/useAdminSkills';
import { listAllAdminSkills } from './adminToolScopeHelpers';
import { isInitialSwrLoading } from './toolScopeSection';

/**
 * Org skill catalog (full cursor traversal). Only fetch skills when the skill
 * view is active — connector auditors must not be blocked by an unauthorized
 * skills list request.
 */
export const useAdminSkillCatalog = (enabled: boolean) => {
  const skillsSWR = useClientDataSWR(
    enabled ? 'admin-tool-scope/skills/all' : null,
    () => listAllAdminSkills(),
    {
      revalidateOnFocus: false,
    },
  );
  const skillItems = useMemo(() => skillsSWR.data ?? [], [skillsSWR.data]);

  const skillRowsByKey = useMemo(
    () => new Map(skillItems.map((item) => [item.skillKey, item])),
    [skillItems],
  );

  const builtinSkillKeys = useMemo(
    () => new Set(bundledBuiltinSkills.map((skill) => skill.identifier)),
    [],
  );

  // Builtin-override rows are represented by the builtin item itself (their
  // distribution shows there), so they must not double up as custom skills.
  const orgSkills: SkillListItem[] = useMemo(
    () =>
      skillItems
        .filter(
          (item) =>
            item.source === 'uploaded' &&
            item.status !== 'archived' &&
            !builtinSkillKeys.has(item.skillKey),
        )
        .map((item) => ({
          createdAt: new Date(0),
          description: item.description,
          id: item.id,
          identifier: item.skillKey,
          manifest: { name: item.displayName } as SkillListItem['manifest'],
          name: item.displayName,
          source: 'user' as SkillListItem['source'],
          updatedAt: new Date(0),
        })),
    [builtinSkillKeys, skillItems],
  );

  const retry = useCallback(() => {
    void skillsSWR.mutate();
    void refreshAdminSkillLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillsSWR.mutate]);

  const error = skillsSWR.error ?? undefined;
  const isLoading = isInitialSwrLoading(skillsSWR);

  return { error, isLoading, orgSkills, retry, skillRowsByKey };
};
