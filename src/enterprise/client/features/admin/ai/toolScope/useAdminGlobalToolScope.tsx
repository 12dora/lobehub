'use client';

import { builtinSkills as bundledBuiltinSkills } from '@lobechat/builtin-skills';
import type { SkillListItem, SkillResourceTreeNode } from '@lobechat/types';
import { toast } from '@lobehub/ui/base-ui';
import isEqual from 'fast-deep-equal';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { ConnectorToolPermission } from '@/database/schemas';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
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
  const skillsSWR = useClientDataSWR('admin-tool-scope/skills/all', () => listAllAdminSkills(), {
    revalidateOnFocus: false,
  });
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
    void skillsSWR.mutate();
    void refreshAdminSkillLists();
    void connectorsListSWR.mutate();
    void connectorDetailsSWR.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillsSWR.mutate, connectorsListSWR.mutate, connectorDetailsSWR.mutate]);

  const connectorPartialDetailError =
    connectorDetailFailedCount > 0
      ? new Error(
          t('aiToolSettings.connectors.partialLoadFailed', {
            count: connectorDetailFailedCount,
          }),
        )
      : undefined;

  const listError =
    view === 'connector'
      ? (connectorsListSWR.error ??
        connectorDetailsSWR.error ??
        connectorPartialDetailError ??
        skillsSWR.error)
      : (skillsSWR.error ?? undefined);
  const listLoading =
    view === 'connector'
      ? Boolean(connectorsListSWR.isLoading && !connectorsListSWR.data)
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
      const row = skillRowsByKey.get(identifier);
      if (row) {
        if (!capabilities.canUpdateSkill) throw new Error('PLATFORM_PERMISSION_DENIED');
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
        if (!capabilities.canCreateSkill) throw new Error('PLATFORM_PERMISSION_DENIED');
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
    (identifier: string, enabled: boolean) =>
      setBuiltinSkillDistribution(identifier, enabled ? 'default' : 'optional'),
    [setBuiltinSkillDistribution],
  );

  // ── org skill create/delete flows ─────────────────────────────────────────
  const createOrgSkillFromParsed = useCallback(
    async (
      parsed: Parameters<typeof buildApplyImmediateVersionPayloadFromImport>[0] & {
        suggestedSkillKey: string;
      },
    ) => {
      if (!capabilities.canCreateSkill) throw new Error('PLATFORM_PERMISSION_DENIED');
      const version = buildApplyImmediateVersionPayloadFromImport(parsed);
      if ('error' in version) {
        throw new Error(
          version.error === 'resources_truncated'
            ? t('skillCatalog.import.resourcesTruncated')
            : t('skillCatalog.version.formInvalid'),
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
    },
    [capabilities.canCreateSkill, notifyApplyOutcome, retry, t],
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
      if (!capabilities.canDeleteSkill) throw new Error('PLATFORM_PERMISSION_DENIED');
      const detail = await adminSkillsService.get({ id: skillId });
      await adminSkillsService.archiveImmediate({
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: skillId,
        reason: REASONS.skillDelete,
      });
      retry();
    },
    [capabilities.canDeleteSkill, retry],
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
      if (!capabilities.canUpdateConnector) throw new Error('PLATFORM_PERMISSION_DENIED');
      const current = await adminConnectorsService.getGovernance();
      await adminConnectorsService.updateBuiltinToolPolicy({
        expectedRevision: current.revision,
        policies: patch(current.doc.builtinToolPolicies ?? {}),
        reason: REASONS.builtinToolPolicy,
      });
      await governanceSWR.mutate();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capabilities.canUpdateConnector, governanceSWR.mutate],
  );

  const applyConnectorToolsPatch = useCallback(
    async (
      connectorId: string,
      patchTools: (
        tools: NonNullable<AdminConnectorGetOutput['draft']['tools']>,
      ) => NonNullable<AdminConnectorGetOutput['draft']['tools']>,
    ) => {
      if (!capabilities.canUpdateConnector) throw new Error('PLATFORM_PERMISSION_DENIED');
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
      retry();
    },
    [capabilities.canUpdateConnector, connectorDetailById, retry],
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
      if (connectorId.startsWith(BUILTIN_ROW_PREFIX)) return;
      if (!capabilities.canDeleteConnector) throw new Error('PLATFORM_PERMISSION_DENIED');
      const cached = connectorDetailById.get(connectorId);
      const detail = cached ?? (await adminConnectorsService.get({ id: connectorId }));
      if (detail.published) {
        await adminConnectorsService.archiveImmediate({
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: connectorId,
          reason: REASONS.connectorDelete,
        });
      } else {
        await adminConnectorsService.deleteDraft({
          expectedDraftToken: detail.draftToken,
          expectedRevision: detail.baseRevision,
          id: connectorId,
          reason: REASONS.connectorDelete,
        });
      }
      retry();
    },
    [capabilities.canDeleteConnector, connectorDetailById, retry],
  );

  const submitCustomConnector = useCallback(
    async (values: {
      auth?: { clientId?: string; clientSecret?: string; token?: string; type?: string };
      identifier: string;
      serverUrl?: string;
      transport: 'http' | 'stdio';
    }) => {
      if (!capabilities.canCreateConnector) throw new Error('PLATFORM_PERMISSION_DENIED');
      if (values.transport !== 'http' || !values.serverUrl) {
        throw new Error(
          t('aiConnectorSettings.httpOnly', {
            defaultValue:
              'Platform connectors support HTTP MCP servers only — stdio runs on user devices and cannot be provided org-wide.',
          }),
        );
      }
      if (values.auth?.type === 'oauth2') {
        throw new Error(
          t('aiConnectorSettings.oauthViaAdvanced', {
            defaultValue:
              'Per-user OAuth platform connectors need the full OAuth configuration — create them in the advanced catalog (Admin → Connectors).',
          }),
        );
      }
      const key = values.identifier
        .toLowerCase()
        .replaceAll(/[^a-z0-9._-]+/g, '-')
        .replaceAll(/^[^a-z0-9]+|[-._]+$/g, '');
      if (!key) throw new Error(t('skillCatalog.version.formInvalid'));

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

      // Parity with the user flow (create → tool sync): probe the endpoint and
      // publish the discovered tool list, defaulting every tool to allowed.
      try {
        const discovered = await adminConnectorsService.discover({
          id: created.draft.id,
          reason: REASONS.connectorDiscover,
        });
        if (discovered.tools.length > 0) {
          const detail = await adminConnectorsService.get({ id: created.draft.id });
          await adminConnectorsService.applyImmediate({
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
        }
      } catch {
        // Endpoint unreachable right now: the draft stays; admin can retry from
        // the advanced catalog. The soft outcome is surfaced via the banner path.
      }
      retry();
    },
    [capabilities.canCreateConnector, retry, t],
  );

  return useMemo<AdminToolScope>(
    () => ({
      capabilities,
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
      capabilities,
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
