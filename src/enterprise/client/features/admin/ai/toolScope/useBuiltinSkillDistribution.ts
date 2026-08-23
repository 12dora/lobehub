'use client';

import { builtinSkills as bundledBuiltinSkills } from '@lobechat/builtin-skills';
import { useCallback } from 'react';

import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import type { AdminSkillDistribution, AdminToolScopeCapabilities } from '@/features/AdminToolScope';

import { buildApplyImmediateVersionPayload } from '../../skills/controller';
import { REASONS } from './adminToolScopeHelpers';
import { LOCAL_ERROR } from './toolScopeErrors';
import type { AdminToolScopeSectionParams } from './toolScopeSection';
import type { useAdminSkillCatalog } from './useAdminSkillCatalog';

interface UseBuiltinSkillDistributionParams {
  capabilities: AdminToolScopeCapabilities;
  notifications: AdminToolScopeSectionParams['notifications'];
  retry: ReturnType<typeof useAdminSkillCatalog>['retry'];
  skillRowsByKey: ReturnType<typeof useAdminSkillCatalog>['skillRowsByKey'];
}

/**
 * Builtin skill org distribution: a code-bundled builtin has no row until the
 * org makes its first decision about it, so reads fall back to the bundled
 * default and the first write materializes an override row.
 */
export const useBuiltinSkillDistribution = ({
  capabilities,
  notifications,
  retry,
  skillRowsByKey,
}: UseBuiltinSkillDistributionParams) => {
  const { notifyApplyOutcome, notifySkillFailure, notifyUnlessAlreadyToasted } = notifications;

  const isBuiltinSkillEnabled = useCallback(
    (identifier: string) => {
      const row = skillRowsByKey.get(identifier);
      if (!row) return true;
      if (row.status === 'archived') return false;
      return row.enabled !== false && row.distribution !== 'optional';
    },
    [skillRowsByKey],
  );

  const getBuiltinSkillDistribution = useCallback(
    (identifier: string): AdminSkillDistribution => {
      const row = skillRowsByKey.get(identifier);
      if (!row || row.status === 'archived') return row ? 'optional' : 'default';
      return row.distribution;
    },
    [skillRowsByKey],
  );

  /** Create when no live override exists; update when one does (ASKC-03). */
  const canSetBuiltinSkillDistribution = useCallback(
    (identifier: string): boolean => {
      const row = skillRowsByKey.get(identifier);
      if (row && row.status !== 'archived') return capabilities.canUpdateSkill;
      return capabilities.canCreateSkill;
    },
    [capabilities.canCreateSkill, capabilities.canUpdateSkill, skillRowsByKey],
  );

  const setBuiltinSkillDistribution = useCallback(
    async (identifier: string, distribution: AdminSkillDistribution) => {
      // Hard applyImmediate failures toast via withAdminAiInfraErrorToast (tagged).
      // Pre-read / local denials are toasted by callers that check the tag.
      const row = skillRowsByKey.get(identifier);
      if (row) {
        if (!capabilities.canUpdateSkill) throw new Error(LOCAL_ERROR.PERMISSION);
        const detail = await adminSkillsService.get({ id: row.id });
        const result = await adminSkillsService.applyImmediate({
          distribution,
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: row.id,
          mode: 'update',
          reason: REASONS.skillDistribution,
        });
        notifyApplyOutcome(result);
      } else {
        if (!capabilities.canCreateSkill) throw new Error(LOCAL_ERROR.PERMISSION);
        // First org-level decision about a code-bundled builtin: materialize an
        // override row carrying the bundled content so the catalog can shadow it.
        const bundled = bundledBuiltinSkills.find((skill) => skill.identifier === identifier);
        if (!bundled) throw new Error(`Unknown builtin skill: ${identifier}`);
        const version = buildApplyImmediateVersionPayload({
          content: bundled.content,
          description: bundled.description ?? null,
          displayName: bundled.name,
          version: '1.0.0',
        });
        if (!version) throw new Error('Failed to build builtin override version');
        const result = await adminSkillsService.applyImmediate({
          allowBuiltinOverride: true,
          description: bundled.description ?? null,
          displayName: bundled.name,
          distribution,
          enabled: true,
          mode: 'create',
          reason: REASONS.skillDistribution,
          skillKey: identifier,
          version,
        });
        notifyApplyOutcome(result);
      }
      retry();
    },
    [
      capabilities.canCreateSkill,
      capabilities.canUpdateSkill,
      notifyApplyOutcome,
      retry,
      skillRowsByKey,
    ],
  );

  const toggleBuiltinSkill = useCallback(
    async (identifier: string, enabled: boolean) => {
      try {
        await setBuiltinSkillDistribution(identifier, enabled ? 'default' : 'optional');
      } catch (err) {
        // applyImmediate already toasts hard failures; cover pre-read + local denials.
        notifyUnlessAlreadyToasted(notifySkillFailure, err);
        throw err;
      }
    },
    [notifySkillFailure, notifyUnlessAlreadyToasted, setBuiltinSkillDistribution],
  );

  return {
    canSetBuiltinSkillDistribution,
    getBuiltinSkillDistribution,
    isBuiltinSkillEnabled,
    setBuiltinSkillDistribution,
    toggleBuiltinSkill,
  };
};
