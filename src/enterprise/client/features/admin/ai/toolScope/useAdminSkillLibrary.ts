'use client';

import { toast } from '@lobehub/ui/base-ui';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import type { AdminToolScopeCapabilities } from '@/features/AdminToolScope';
import { marketApiService } from '@/services/marketApi';

import { readFileBase64 } from '../../primitives/readFileBase64';
import { buildApplyImmediateVersionPayloadFromImport } from '../../skills/controller';
import { REASONS, sanitizeSkillKey } from './adminToolScopeHelpers';
import { isLocalAdapterError, LOCAL_ERROR } from './toolScopeErrors';
import type { AdminToolScopeSectionParams } from './toolScopeSection';
import type { useAdminSkillCatalog } from './useAdminSkillCatalog';

interface UseAdminSkillLibraryParams {
  capabilities: AdminToolScopeCapabilities;
  notifications: AdminToolScopeSectionParams['notifications'];
  retry: ReturnType<typeof useAdminSkillCatalog>['retry'];
}

type ParsedSkillImport = Parameters<typeof buildApplyImmediateVersionPayloadFromImport>[0] & {
  suggestedSkillKey: string;
};

/** Org skill create/import/delete flows. */
export const useAdminSkillLibrary = ({
  capabilities,
  notifications,
  retry,
}: UseAdminSkillLibraryParams) => {
  const { t } = useTranslation('admin');
  const { notifyApplyOutcome, notifySkillFailure, notifyUnlessAlreadyToasted } = notifications;

  const createOrgSkillFromParsed = useCallback(
    async (parsed: ParsedSkillImport) => {
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

  return {
    deleteOrgSkill,
    importFromGithub,
    importFromUrl,
    importFromZip,
    installFromMarket,
  };
};
