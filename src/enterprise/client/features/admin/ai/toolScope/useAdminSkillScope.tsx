import { builtinSkills as bundledBuiltinSkills } from '@lobechat/builtin-skills';
import type { SkillListItem, SkillResourceTreeNode } from '@lobechat/types';
import { toast } from '@lobehub/ui/base-ui';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import type {
  AdminOrgSkillDetailData,
  AdminSkillDistribution,
  AdminToolScopeCapabilities,
} from '@/features/AdminToolScope';
import { useClientDataSWR } from '@/libs/swr';
import { marketApiService } from '@/services/marketApi';

import { readFileBase64 } from '../../primitives/readFileBase64';
import {
  buildApplyImmediateVersionPayload,
  buildApplyImmediateVersionPayloadFromImport,
} from '../../skills/controller';
import { refreshAdminSkillLists } from '../../skills/hooks/useAdminSkills';
import { listAllAdminSkills, REASONS, sanitizeSkillKey } from './adminToolScopeHelpers';
import { isLocalAdapterError, LOCAL_ERROR } from './toolScopeErrors';
import type { useToolScopeNotifications } from './useToolScopeNotifications';

interface UseAdminSkillScopeParams {
  capabilities: AdminToolScopeCapabilities;
  enabled: boolean;
  notifications: ReturnType<typeof useToolScopeNotifications>;
}

export const useAdminSkillScope = ({
  capabilities,
  enabled,
  notifications,
}: UseAdminSkillScopeParams) => {
  const { t } = useTranslation('admin');
  const { notifyApplyOutcome, notifySkillFailure, notifyUnlessAlreadyToasted } = notifications;

  // ── org skill catalog (full cursor traversal) ─────────────────────────────
  // Only fetch skills when the skill view is active — connector auditors must
  // not be blocked by an unauthorized skills list request.
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
  const isLoading = Boolean(skillsSWR.isLoading && !skillsSWR.data);

  // ── builtin skill org distribution ────────────────────────────────────────
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

  // ── org skill create/delete flows ─────────────────────────────────────────
  const createOrgSkillFromParsed = useCallback(
    async (
      parsed: Parameters<typeof buildApplyImmediateVersionPayloadFromImport>[0] & {
        suggestedSkillKey: string;
      },
    ) => {
      try {
        if (!capabilities.canCreateSkill) throw new Error(LOCAL_ERROR.PERMISSION);
        const version = buildApplyImmediateVersionPayloadFromImport(parsed);
        if ('error' in version) {
          throw new Error(
            version.error === 'resources_truncated'
              ? LOCAL_ERROR.SKILL_RESOURCES_TRUNCATED
              : LOCAL_ERROR.SKILL_FORM_INVALID,
          );
        }
        const result = await adminSkillsService.applyImmediate({
          allowBuiltinOverride: false,
          description: parsed.description,
          displayName: parsed.displayName,
          distribution: 'default',
          enabled: true,
          mode: 'create',
          reason: REASONS.skillImport,
          skillKey: parsed.suggestedSkillKey,
          version,
        });
        notifyApplyOutcome(result);
        retry();
      } catch (err) {
        // applyImmediate toasts service failures; cover local permission / parse markers.
        if (isLocalAdapterError(err)) notifySkillFailure();
        throw err;
      }
    },
    [capabilities.canCreateSkill, notifyApplyOutcome, notifySkillFailure, retry],
  );

  const importFromUrl = useCallback(
    async (url: string) => {
      const parsed = await adminSkillsService.parseImportSource({ source: 'url', url });
      await createOrgSkillFromParsed(parsed);
    },
    [createOrgSkillFromParsed],
  );

  const importFromGithub = useCallback(
    async (repoUrl: string) => {
      const parsed = await adminSkillsService.parseImportSource({ repoUrl, source: 'github' });
      await createOrgSkillFromParsed(parsed);
    },
    [createOrgSkillFromParsed],
  );

  const importFromZip = useCallback(
    async (file: File) => {
      const zipBase64 = await readFileBase64(file);
      const parsed = await adminSkillsService.parseImportSource({
        fileName: file.name,
        source: 'zip',
        zipBase64,
      });
      await createOrgSkillFromParsed(parsed);
    },
    [createOrgSkillFromParsed],
  );

  const installFromMarket = useCallback(
    async (identifier: string) => {
      const downloadUrl = marketApiService.getSkillDownloadUrl(encodeURIComponent(identifier));
      const parsed = await adminSkillsService.parseImportSource({
        source: 'url',
        url: downloadUrl,
      });
      const marketKey = sanitizeSkillKey(identifier);
      await createOrgSkillFromParsed({
        ...parsed,
        suggestedSkillKey: marketKey || parsed.suggestedSkillKey,
      });
    },
    [createOrgSkillFromParsed],
  );

  const deleteOrgSkill = useCallback(
    async (skillId: string) => {
      try {
        if (!capabilities.canDeleteSkill) throw new Error(LOCAL_ERROR.PERMISSION);
        const detail = await adminSkillsService.get({ id: skillId });
        await adminSkillsService.archiveImmediate({
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: skillId,
          reason: REASONS.skillDelete,
        });
        toast.success(t('skillCatalog.toast.archive'));
        retry();
      } catch (err) {
        // archiveImmediate already toasts hard failures; cover get() + local deny.
        notifyUnlessAlreadyToasted(notifySkillFailure, err);
        throw err;
      }
    },
    [capabilities.canDeleteSkill, notifySkillFailure, notifyUnlessAlreadyToasted, retry, t],
  );

  // ── org skill detail (AgentSkillDetail parity) ────────────────────────────
  const useOrgSkillDetail = useCallback((skillId: string) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- stable hook impl injected as datasource
    const swr = useClientDataSWR(
      ['admin-tool-scope/skill-detail', skillId],
      async (): Promise<AdminOrgSkillDetailData> => {
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
        const resourceTree: SkillResourceTreeNode[] = [
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
        return {
          resourceTree,
          skillDetail: {
            content,
            description: detail.draft.description,
            manifest: (version?.manifest ?? null) as Record<string, any> | null,
            name: detail.draft.displayName,
            updatedAt: (version as { createdAt?: string } | null)?.createdAt ?? new Date(0),
          },
        };
      },
      { revalidateOnFocus: false },
    );
    return { data: swr.data, isLoading: Boolean(swr.isLoading && !swr.data) };
  }, []);

  return {
    canSetBuiltinSkillDistribution,
    deleteOrgSkill,
    error,
    getBuiltinSkillDistribution,
    importFromGithub,
    importFromUrl,
    importFromZip,
    installFromMarket,
    isBuiltinSkillEnabled,
    isLoading,
    orgSkills,
    retry,
    setBuiltinSkillDistribution,
    toggleBuiltinSkill,
    useOrgSkillDetail,
  };
};
