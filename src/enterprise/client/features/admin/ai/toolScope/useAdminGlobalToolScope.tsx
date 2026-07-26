'use client';

import { builtinSkills as bundledBuiltinSkills } from '@lobechat/builtin-skills';
import type { SkillListItem, SkillResourceTreeNode } from '@lobechat/types';
import { Alert } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import isEqual from 'fast-deep-equal';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectorToolPermission } from '@/database/schemas';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { isAdminAiInfraErrorToasted } from '@/enterprise/client/services/adminAiInfraAdapter/errors';
import { adminConnectorsService } from '@/enterprise/client/services/adminConnectors';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import type {
  AdminOrgSkillDetailData,
  AdminSkillDistribution,
  AdminToolScope,
} from '@/features/AdminToolScope';
import { inferCrudType } from '@/libs/mcp/utils';
import { useClientDataSWR } from '@/libs/swr';
import { marketApiService } from '@/services/marketApi';
import { useToolStore } from '@/store/tool';
import type { ConnectorTool, ConnectorWithTools } from '@/store/tool/slices/connector/types';

import type { AdminConnectorGetOutput } from '../../connectors/types';
import { readFileBase64 } from '../../primitives/readFileBase64';
import {
  buildApplyImmediateVersionPayload,
  buildApplyImmediateVersionPayloadFromImport,
} from '../../skills/controller';
import { refreshAdminSkillLists } from '../../skills/hooks/useAdminSkills';
import {
  BUILTIN_ROW_PREFIX,
  deriveToolScopeCapabilities,
  listAllAdminConnectors,
  listAllAdminSkills,
  loadAllConnectorDetails,
  permissionToPolicy,
  PLATFORM_TOOL_PREFIX,
  policyToPermission,
  REASONS,
  sanitizeSkillKey,
} from './adminToolScopeHelpers';

/**
 * Locale-independent sentinels for adapter-local preconditions.
 * Do not put translated copy in Error.message and then string-match it (breaks under zh-CN).
 */
const LOCAL_ERROR = {
  CONNECTOR_HTTP_ONLY: 'CONNECTOR_HTTP_ONLY',
  CONNECTOR_IDENTIFIER_INVALID: 'CONNECTOR_IDENTIFIER_INVALID',
  CONNECTOR_OAUTH_VIA_ADVANCED: 'CONNECTOR_OAUTH_VIA_ADVANCED',
  CREATE_DISCOVERY_FAILED: 'CONNECTOR_CREATE_DISCOVERY_FAILED',
  CREATE_INCOMPLETE: 'CONNECTOR_CREATE_INCOMPLETE',
  PERMISSION: 'PLATFORM_PERMISSION_DENIED',
  SKILL_FORM_INVALID: 'SKILL_VERSION_FORM_INVALID',
  SKILL_RESOURCES_TRUNCATED: 'SKILL_IMPORT_RESOURCES_TRUNCATED',
} as const;

/** Local guard / parse failures that never reach a toasting service wrapper. */
const isLocalAdapterError = (err: unknown) =>
  err instanceof Error &&
  (err.message === LOCAL_ERROR.PERMISSION ||
    err.message === LOCAL_ERROR.CONNECTOR_HTTP_ONLY ||
    err.message === LOCAL_ERROR.CONNECTOR_OAUTH_VIA_ADVANCED ||
    err.message === LOCAL_ERROR.CONNECTOR_IDENTIFIER_INVALID ||
    err.message === LOCAL_ERROR.SKILL_FORM_INVALID ||
    err.message === LOCAL_ERROR.SKILL_RESOURCES_TRUNCATED);

const isPartialCreateMarker = (err: unknown) =>
  err instanceof Error &&
  (err.message === LOCAL_ERROR.CREATE_INCOMPLETE ||
    err.message === LOCAL_ERROR.CREATE_DISCOVERY_FAILED);

/**
 * Builds the org-global datasource for the user-facing skill/connector settings
 * UI rendered inside the admin panel. Every read targets admin.skills /
 * admin.connectors; every write is an applyImmediate (draft + publish) so the
 * change is live for the whole organization.
 */
export const useAdminGlobalToolScope = (view: 'connector' | 'skill'): AdminToolScope => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const capabilities = useMemo(() => deriveToolScopeCapabilities(permissions), [permissions]);
  const builtinTools = useToolStore((s) => s.builtinTools, isEqual);

  // ── org skill catalog (full cursor traversal) ─────────────────────────────
  // Only fetch skills when the skill view is active — connector auditors must
  // not be blocked by an unauthorized skills list request.
  const skillsEnabled = view === 'skill';
  const skillsSWR = useClientDataSWR(
    skillsEnabled ? 'admin-tool-scope/skills/all' : null,
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

  // ── platform connector catalog (full list + batched details) ──────────────
  const connectorsEnabled = view === 'connector';
  const connectorsListSWR = useClientDataSWR(
    connectorsEnabled ? 'admin-tool-scope/connectors/all' : null,
    () => listAllAdminConnectors(),
    { revalidateOnFocus: false },
  );
  // Org governance: builtin tool permission matrix + shared OAuth designation.
  const governanceSWR = useClientDataSWR(
    connectorsEnabled ? 'admin-tool-scope/connectors/governance' : null,
    () => adminConnectorsService.getGovernance(),
    { revalidateOnFocus: false },
  );
  const mutateGovernance = governanceSWR.mutate;
  const governance = governanceSWR.data;
  const builtinToolPolicies = governance?.doc.builtinToolPolicies;
  const connectorListItems = connectorsListSWR.data ?? [];
  const connectorDetailKey = connectorListItems.map((item) => item.id).join('|');
  const connectorDetailsSWR = useClientDataSWR(
    connectorsEnabled && connectorListItems.length > 0
      ? ['admin-tool-scope/connectors/details', connectorDetailKey]
      : null,
    async () => loadAllConnectorDetails(connectorListItems.map((item) => item.id)),
    { revalidateOnFocus: false },
  );

  const connectorDetails = useMemo(
    () => connectorDetailsSWR.data?.items ?? [],
    [connectorDetailsSWR.data],
  );
  const connectorDetailFailedCount = connectorDetailsSWR.data?.failedIds.length ?? 0;
  const connectorDetailById = useMemo(
    () => new Map(connectorDetails.map((detail) => [detail.draft.id, detail])),
    [connectorDetails],
  );

  const connectors: ConnectorWithTools[] = useMemo(() => {
    // Builtin in-process tools, synthesized from the static manifests with the
    // same crud grouping the user connector sync applies server-side.
    const builtinRows: ConnectorWithTools[] = builtinTools
      .filter((tool) => !tool.hidden)
      .map((tool) => {
        const api = (tool.manifest?.api ?? []) as {
          description?: string;
          name: string;
          parameters?: Record<string, unknown>;
        }[];
        const identifierPolicies = builtinToolPolicies?.[tool.identifier];
        const tools: ConnectorTool[] = api.map((entry) => ({
          crudType: inferCrudType(entry.name),
          description: entry.description ?? null,
          displayName: entry.name,
          id: `${BUILTIN_ROW_PREFIX}${tool.identifier}:${entry.name}`,
          inputSchema: (entry.parameters ?? null) as Record<string, unknown> | null,
          permission: (identifierPolicies?.[entry.name] ??
            ConnectorToolPermission.auto) as ConnectorToolPermission,
          toolName: entry.name,
          userConnectorId: `${BUILTIN_ROW_PREFIX}${tool.identifier}`,
        }));
        return {
          credentials: null,
          id: `${BUILTIN_ROW_PREFIX}${tool.identifier}`,
          identifier: tool.identifier,
          isEnabled: true,
          mcpConnectionType: null,
          mcpServerUrl: null,
          metadata: null,
          name: tool.title || tool.identifier,
          sourceType: 'builtin',
          status: 'connected',
          tools,
        };
      });

    const platformRows: ConnectorWithTools[] = connectorDetails
      .filter((detail) => detail.draft.status !== 'archived')
      .map((detail) => ({
        credentials: null,
        id: detail.draft.id,
        identifier: detail.draft.key,
        isEnabled: detail.draft.enabled ?? true,
        mcpConnectionType: 'http',
        mcpServerUrl: detail.draft.endpoint,
        metadata: detail.draft.description ? { description: detail.draft.description } : null,
        name: detail.draft.displayName,
        sourceType: 'custom',
        status: detail.published ? 'connected' : 'disconnected',
        tools: (detail.draft.tools ?? []).map((tool): ConnectorTool => ({
          crudType: inferCrudType(tool.toolKey),
          description: tool.description ?? null,
          displayName: tool.displayName ?? null,
          id: `${PLATFORM_TOOL_PREFIX}${detail.draft.id}:${tool.toolKey}`,
          inputSchema: (tool.inputSchema ?? null) as Record<string, unknown> | null,
          permission: policyToPermission(tool),
          toolName: tool.toolKey,
          userConnectorId: detail.draft.id,
        })),
      }));

    return [...builtinRows, ...platformRows];
  }, [builtinToolPolicies, builtinTools, connectorDetails]);

  // ── shared refresh / list state ───────────────────────────────────────────
  const retry = useCallback(() => {
    if (view === 'skill') {
      void skillsSWR.mutate();
      void refreshAdminSkillLists();
      return;
    }
    void connectorsListSWR.mutate();
    void connectorDetailsSWR.mutate();
    void mutateGovernance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view,
    skillsSWR.mutate,
    connectorsListSWR.mutate,
    connectorDetailsSWR.mutate,
    mutateGovernance,
  ]);
  const retryGovernance = useCallback(() => {
    void mutateGovernance();
  }, [mutateGovernance]);

  const connectorPartialDetailError =
    connectorDetailFailedCount > 0
      ? new Error(
          t('aiToolSettings.connectors.partialLoadFailed', {
            count: connectorDetailFailedCount,
          }),
        )
      : undefined;
  const governanceFailureActiveRef = useRef(false);

  useEffect(() => {
    if (view !== 'connector') {
      governanceFailureActiveRef.current = false;
      return;
    }

    if (governanceSWR.error) {
      if (governanceFailureActiveRef.current) return;
      governanceFailureActiveRef.current = true;
      toast.error(t('aiToolSettings.connectors.governanceLoadFailed'));
      return;
    }

    if (governanceSWR.data && !governanceSWR.isValidating) {
      governanceFailureActiveRef.current = false;
    }
  }, [governanceSWR.data, governanceSWR.error, governanceSWR.isValidating, t, view]);

  const listError =
    view === 'connector'
      ? (connectorsListSWR.error ??
        governanceSWR.error ??
        connectorDetailsSWR.error ??
        connectorPartialDetailError)
      : (skillsSWR.error ?? undefined);
  const listLoading =
    view === 'connector'
      ? Boolean(
          (connectorsListSWR.isLoading && !connectorsListSWR.data) ||
          (governanceSWR.isLoading && !governanceSWR.data),
        )
      : Boolean(skillsSWR.isLoading && !skillsSWR.data);

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

  /**
   * Toast adapter-boundary failures unless the service wrapper already did.
   * Covers pre-read hops (`get` / `getGovernance`) and unwrapped local guards.
   */
  const notifyUnlessAlreadyToasted = useCallback((notify: () => void, err: unknown) => {
    if (!isAdminAiInfraErrorToasted(err)) notify();
  }, []);

  const notifySkillFailure = useCallback(() => {
    toast.error(t('skillCatalog.errors.generic'));
  }, [t]);

  const notifyConnectorFailure = useCallback(() => {
    toast.error(t('connectorCatalog.errors.generic'));
  }, [t]);

  // Coalesce rapid tool-permission success toasts (one per ~1.2s window).
  const lastConnectorSavedToastAtRef = useRef(0);
  const notifyConnectorSaved = useCallback(() => {
    const now = Date.now();
    if (now - lastConnectorSavedToastAtRef.current < 1200) return;
    lastConnectorSavedToastAtRef.current = now;
    toast.success(t('connectorCatalog.toast.saved'));
  }, [t]);

  const connectorNotice = useMemo(
    () =>
      governanceSWR.error ? (
        <Alert
          showIcon
          type="error"
          action={
            <Button onClick={retryGovernance}>
              {t('aiToolSettings.connectors.retryGovernance', {
                defaultValue: 'Retry permissions',
              })}
            </Button>
          }
          message={t('aiToolSettings.connectors.governanceLoadFailed', {
            defaultValue: 'Connector permissions could not be loaded. Retry before making changes.',
          })}
        />
      ) : undefined,
    [governanceSWR.error, retryGovernance, t],
  );

  const localizePublishError = useCallback(
    (publishError: string) => {
      // Server may join multiple validation codes with commas; localize the primary code.
      const primary = publishError.split(',')[0]?.trim() || publishError;
      if (primary === 'version_required') {
        return t('skillCatalog.publishError.version_required');
      }
      if (primary === 'publish_failed' || primary === 'validation_failed') {
        return t(`skillCatalog.publishError.${primary}` as never);
      }
      return t(`skillCatalog.validation.issue.${primary}` as never, {
        defaultValue: t('skillCatalog.publishError.validation_failed'),
        path: t('skillCatalog.validation.path.root'),
      });
    },
    [t],
  );

  const notifyApplyOutcome = useCallback(
    (result: { publishError?: string | null; published: boolean }) => {
      if (result.published) {
        toast.success(
          t('aiSkillSettings.orgDefault.saved', { defaultValue: 'Organization default updated' }),
        );
      } else {
        toast.warning(
          result.publishError
            ? localizePublishError(result.publishError)
            : t('aiSkillSettings.actions.draftSaved', {
                defaultValue: 'Saved as draft — publish is pending',
              }),
        );
      }
    },
    [localizePublishError, t],
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

  // ── connector policy writes ───────────────────────────────────────────────
  // Builtin rows edit the ORG governance matrix (platform_connector_governance);
  // they fall back to read-only while governance is missing or the admin lacks update.
  const isConnectorReadOnly = useCallback(
    (connector: ConnectorWithTools) =>
      !capabilities.canUpdateConnector ||
      (connector.id.startsWith(BUILTIN_ROW_PREFIX) && !governance),
    [capabilities.canUpdateConnector, governance],
  );

  const updateBuiltinPolicies = useCallback(
    async (
      patch: (
        policies: NonNullable<typeof builtinToolPolicies>,
      ) => NonNullable<typeof builtinToolPolicies>,
    ) => {
      try {
        if (!capabilities.canUpdateConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        const current = await adminConnectorsService.getGovernance();
        await adminConnectorsService.updateBuiltinToolPolicy({
          expectedRevision: current.revision,
          policies: patch(current.doc.builtinToolPolicies ?? {}),
          reason: REASONS.builtinToolPolicy,
        });
        notifyConnectorSaved();
        await mutateGovernance();
      } catch (err) {
        // Service wrapper toasts hard failures; cover getGovernance + local deny.
        notifyUnlessAlreadyToasted(notifyConnectorFailure, err);
        throw err;
      }
    },

    [
      capabilities.canUpdateConnector,
      mutateGovernance,
      notifyConnectorFailure,
      notifyConnectorSaved,
      notifyUnlessAlreadyToasted,
    ],
  );

  const applyConnectorToolsPatch = useCallback(
    async (
      connectorId: string,
      patchTools: (
        tools: NonNullable<AdminConnectorGetOutput['draft']['tools']>,
      ) => NonNullable<AdminConnectorGetOutput['draft']['tools']>,
    ) => {
      try {
        if (!capabilities.canUpdateConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        const cached = connectorDetailById.get(connectorId);
        const detail = cached ?? (await adminConnectorsService.get({ id: connectorId }));
        const tools = detail.draft.tools ?? [];
        await adminConnectorsService.applyImmediate({
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: connectorId,
          mode: 'update',
          reason: REASONS.connectorPolicy,
          tools: patchTools(tools),
        });
        notifyConnectorSaved();
        retry();
      } catch (err) {
        // applyImmediate toasts hard failures; cover get() + local deny.
        notifyUnlessAlreadyToasted(notifyConnectorFailure, err);
        throw err;
      }
    },
    [
      capabilities.canUpdateConnector,
      connectorDetailById,
      notifyConnectorFailure,
      notifyConnectorSaved,
      notifyUnlessAlreadyToasted,
      retry,
    ],
  );

  const updateToolPermission = useCallback(
    async (toolId: string, permission: ConnectorToolPermission) => {
      if (toolId.startsWith(BUILTIN_ROW_PREFIX)) {
        // `admin-builtin:<identifier>:<toolName>` → org governance matrix entry.
        const [, identifier, ...nameParts] = toolId.split(':');
        const toolName = nameParts.join(':');
        await updateBuiltinPolicies((policies) => ({
          ...policies,
          [identifier]: { ...policies[identifier], [toolName]: permission },
        }));
        return;
      }
      if (!toolId.startsWith(PLATFORM_TOOL_PREFIX)) return;
      const [, connectorId, ...toolKeyParts] = toolId.split(':');
      const toolKey = toolKeyParts.join(':');
      const policy = permissionToPolicy(permission);
      await applyConnectorToolsPatch(connectorId, (tools) =>
        tools.map((tool) => (tool.toolKey === toolKey ? { ...tool, ...policy } : tool)),
      );
    },
    [applyConnectorToolsPatch, updateBuiltinPolicies],
  );

  const resetConnectorPermissions = useCallback(
    async (connectorId: string) => {
      if (connectorId.startsWith(BUILTIN_ROW_PREFIX)) {
        // Reset = drop this builtin's org overrides so every tool reverts to auto.
        const identifier = connectorId.slice(BUILTIN_ROW_PREFIX.length);
        await updateBuiltinPolicies((policies) => {
          const next = { ...policies };
          delete next[identifier];
          return next;
        });
        return;
      }
      await applyConnectorToolsPatch(connectorId, (tools) =>
        tools.map((tool) => ({
          ...tool,
          platformPolicy: 'allow' as const,
          requiresConfirmation: false,
        })),
      );
    },
    [applyConnectorToolsPatch, updateBuiltinPolicies],
  );

  const deleteConnector = useCallback(
    async (connectorId: string) => {
      try {
        if (connectorId.startsWith(BUILTIN_ROW_PREFIX)) return;
        if (!capabilities.canDeleteConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        const cached = connectorDetailById.get(connectorId);
        const detail = cached ?? (await adminConnectorsService.get({ id: connectorId }));
        if (detail.published) {
          await adminConnectorsService.archiveImmediate({
            expectedDraftToken: detail.draftToken,
            expectedRevision: detail.baseRevision,
            id: connectorId,
            reason: REASONS.connectorDelete,
          });
          toast.success(t('connectorCatalog.toast.archived'));
        } else {
          await adminConnectorsService.deleteDraft({
            expectedDraftToken: detail.draftToken,
            expectedRevision: detail.baseRevision,
            id: connectorId,
            reason: REASONS.connectorDelete,
          });
          toast.success(t('connectorCatalog.toast.deleted'));
        }
        retry();
      } catch (err) {
        // deleteDraft/archiveImmediate toast via wrapper when real; mocks/pre-reads need this.
        notifyUnlessAlreadyToasted(notifyConnectorFailure, err);
        throw err;
      }
    },
    [
      capabilities.canDeleteConnector,
      connectorDetailById,
      notifyConnectorFailure,
      notifyUnlessAlreadyToasted,
      retry,
      t,
    ],
  );

  const submitCustomConnector = useCallback(
    async (values: {
      auth?: { clientId?: string; clientSecret?: string; token?: string; type?: string };
      identifier: string;
      serverUrl?: string;
      transport: 'http' | 'stdio';
    }) => {
      try {
        if (!capabilities.canCreateConnector) throw new Error(LOCAL_ERROR.PERMISSION);
        if (values.transport !== 'http' || !values.serverUrl) {
          throw new Error(LOCAL_ERROR.CONNECTOR_HTTP_ONLY);
        }
        if (values.auth?.type === 'oauth2') {
          throw new Error(LOCAL_ERROR.CONNECTOR_OAUTH_VIA_ADVANCED);
        }
        const key = values.identifier
          .toLowerCase()
          .replaceAll(/[^a-z0-9._-]+/g, '-')
          .replaceAll(/^[^a-z0-9]+|[-._]+$/g, '');
        if (!key) throw new Error(LOCAL_ERROR.CONNECTOR_IDENTIFIER_INVALID);

        const base = {
          displayName: values.identifier,
          enabled: true,
          endpoint: values.serverUrl,
          key,
          reason: REASONS.connectorCreate,
          transport: 'http' as const,
        };
        const token = values.auth?.type === 'bearer' ? values.auth?.token?.trim() : undefined;
        const created = token
          ? await adminConnectorsService.applyImmediate({
              ...base,
              credentialMode: 'shared_service_account',
              mode: 'create',
              sharedSecret: { operation: 'replace', value: { bearerToken: token } },
            })
          : await adminConnectorsService.applyImmediate({
              ...base,
              credentialMode: 'none',
              mode: 'create',
            });

        // Soft publish failure on create: draft exists but is not live.
        if (created.published === false) {
          toast.warning(
            t('aiToolSettings.connectors.createIncomplete', {
              defaultValue:
                'Connector draft was created, but discovery or publish did not complete. Finish setup in the advanced catalog.',
            }),
          );
          retry();
          // Reject so the create modal does not treat this as full success (AI-06).
          throw new Error(LOCAL_ERROR.CREATE_INCOMPLETE);
        }

        // Parity with the user flow (create → tool sync): probe the endpoint and
        // publish the discovered tool list, defaulting every tool to allowed.
        try {
          const discovered = await adminConnectorsService.discover({
            id: created.draft.id,
            reason: REASONS.connectorDiscover,
          });
          if (discovered.tools.length > 0) {
            const detail = await adminConnectorsService.get({ id: created.draft.id });
            const toolsUpdate = await adminConnectorsService.applyImmediate({
              expectedDraftToken: detail.draftToken,
              expectedRevision: detail.baseRevision,
              id: created.draft.id,
              mode: 'update',
              reason: REASONS.connectorCreate,
              tools: discovered.tools.map((tool, index) => ({
                ...tool,
                id: `${key}-${index}`,
                platformPolicy: 'allow' as const,
                requiresConfirmation: false,
              })),
            });
            if (toolsUpdate.published === false) {
              toast.warning(
                t('aiToolSettings.connectors.createIncomplete', {
                  defaultValue:
                    'Connector draft was created, but discovery or publish did not complete. Finish setup in the advanced catalog.',
                }),
              );
              retry();
              throw new Error(LOCAL_ERROR.CREATE_INCOMPLETE);
            }
          }
        } catch (discoverErr) {
          if (isPartialCreateMarker(discoverErr)) {
            throw discoverErr;
          }
          // Endpoint unreachable: draft stays; surface partial success and keep modal open.
          toast.warning(
            t('connectorCatalog.toast.createdDiscoveryFailed', {
              defaultValue:
                'Connector created, but tool discovery failed. Open the advanced catalog to retry discovery.',
            }),
          );
          retry();
          throw new Error(LOCAL_ERROR.CREATE_DISCOVERY_FAILED, { cause: discoverErr });
        }
        toast.success(t('connectorCatalog.toast.created'));
        retry();
      } catch (err) {
        // Partial-success paths already toasted a warning and rethrew a typed marker.
        // Hard applyImmediate failures are toasted by withAdminAiInfraErrorToast.
        // Local precondition failures need a generic connector toast.
        if (isLocalAdapterError(err)) notifyConnectorFailure();
        throw err;
      }
    },
    [capabilities.canCreateConnector, notifyConnectorFailure, retry, t],
  );

  return useMemo<AdminToolScope>(
    () => ({
      canSetBuiltinSkillDistribution,
      capabilities,
      connectorNotice,
      connectors,
      deleteConnector,
      deleteOrgSkill,
      getBuiltinSkillDistribution,
      importFromGithub,
      importFromUrl,
      importFromZip,
      installFromMarket,
      isBuiltinSkillEnabled,
      isConnectorReadOnly,
      listError,
      listLoading,
      orgSkills,
      resetConnectorPermissions,
      retry,
      setBuiltinSkillDistribution,
      submitCustomConnector,
      toggleBuiltinSkill,
      updateToolPermission,
      useOrgSkillDetail,
    }),
    [
      canSetBuiltinSkillDistribution,
      capabilities,
      connectorNotice,
      connectors,
      deleteConnector,
      deleteOrgSkill,
      getBuiltinSkillDistribution,
      importFromGithub,
      importFromUrl,
      importFromZip,
      installFromMarket,
      isBuiltinSkillEnabled,
      isConnectorReadOnly,
      listError,
      listLoading,
      orgSkills,
      resetConnectorPermissions,
      retry,
      setBuiltinSkillDistribution,
      submitCustomConnector,
      toggleBuiltinSkill,
      updateToolPermission,
      useOrgSkillDetail,
    ],
  );
};
