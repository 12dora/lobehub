// @vitest-environment happy-dom
import { builtinSkills as bundledBuiltinSkills } from '@lobechat/builtin-skills';
import { toast } from '@lobehub/ui/base-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectorToolPermission } from '@/database/schemas';

import { useAdminGlobalToolScope } from './useAdminGlobalToolScope';

const mocks = vi.hoisted(() => ({
  connectors: {
    applyImmediate: vi.fn(),
    archiveImmediate: vi.fn(),
    deleteDraft: vi.fn(),
    discover: vi.fn(),
    get: vi.fn(),
    getBatch: vi.fn(),
    getGovernance: vi.fn(),
    list: vi.fn(),
    setSharedAuthorization: vi.fn(),
    updateBuiltinToolPolicy: vi.fn(),
  },
  skills: {
    applyImmediate: vi.fn(),
    archiveImmediate: vi.fn(),
    get: vi.fn(),
    getVersion: vi.fn(),
    list: vi.fn(),
    parseImportSource: vi.fn(),
  },
}));

vi.mock('@/enterprise/client/services/adminSkills', () => ({
  adminSkillsService: mocks.skills,
}));

vi.mock('@/enterprise/client/services/adminConnectors', () => ({
  adminConnectorsService: mocks.connectors,
}));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, options?: string | { defaultValue?: string; count?: number }) => {
      if (typeof options === 'string') return options;
      if (options?.defaultValue) return options.defaultValue;
      if (typeof options?.count === 'number' && key.includes('partialLoadFailed')) {
        return `${options.count} connectors failed to load; retry to refresh.`;
      }
      return key;
    },
  }),
}));

const accessMocks = vi.hoisted(() => ({
  permissions: [
    'platform_skill:read:all',
    'platform_skill:create:all',
    'platform_skill:update:all',
    'platform_skill:delete:all',
    'platform_skill:publish:all',
    'platform_connector:read:all',
    'platform_connector:create:all',
    'platform_connector:update:all',
    'platform_connector:delete:all',
    'platform_connector:publish:all',
  ] as string[],
}));

vi.mock('@/enterprise/client/providers/AdminAccessProvider', () => ({
  useAdminAccess: () => ({
    authMethod: null,
    permissions: accessMocks.permissions,
  }),
}));

const skillRow = (overrides: Record<string, unknown> = {}) => ({
  allowBuiltinOverride: false,
  currentVersionId: null,
  description: 'An org skill',
  displayName: 'Org Skill',
  distribution: 'default',
  draftSequence: 0,
  enabled: true,
  id: 'skill-row-1',
  revision: 1,
  skillKey: 'org.skill',
  source: 'uploaded',
  status: 'published',
  ...overrides,
});

const connectorDetail = (overrides: Record<string, unknown> = {}) => ({
  baseRevision: 5,
  draft: {
    connectionTest: null,
    credentialMode: 'none',
    description: null,
    displayName: 'Jira',
    enabled: true,
    endpoint: 'https://mcp.example.com/jira',
    id: 'conn-1',
    key: 'jira',
    revision: 5,
    sort: 0,
    status: 'published',
    tools: [
      {
        description: null,
        displayName: 'Create Issue',
        id: 'jira-0',
        inputSchema: {},
        outputSchema: null,
        platformPolicy: 'allow',
        requiresConfirmation: true,
        riskLevel: 'medium',
        sort: 0,
        toolKey: 'create_issue',
      },
      {
        description: null,
        displayName: 'Search Issues',
        id: 'jira-1',
        inputSchema: {},
        outputSchema: null,
        platformPolicy: 'allow',
        requiresConfirmation: false,
        riskLevel: 'low',
        sort: 1,
        toolKey: 'search_issues',
      },
      {
        description: null,
        displayName: 'Delete Issue',
        id: 'jira-2',
        inputSchema: {},
        outputSchema: null,
        platformPolicy: 'deny',
        requiresConfirmation: false,
        riskLevel: 'high',
        sort: 2,
        toolKey: 'delete_issue',
      },
    ],
    transport: 'http',
  },
  draftToken: 'c'.repeat(64),
  published: {},
  ...overrides,
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
);

const renderScope = (view: 'connector' | 'skill') =>
  renderHook(() => useAdminGlobalToolScope(view), { wrapper });

beforeEach(() => {
  vi.clearAllMocks();
  accessMocks.permissions = [
    'platform_skill:read:all',
    'platform_skill:create:all',
    'platform_skill:update:all',
    'platform_skill:delete:all',
    'platform_skill:publish:all',
    'platform_connector:read:all',
    'platform_connector:create:all',
    'platform_connector:update:all',
    'platform_connector:delete:all',
    'platform_connector:publish:all',
  ];
  vi.spyOn(toast, 'success').mockImplementation(() => '' as never);
  vi.spyOn(toast, 'warning').mockImplementation(() => '' as never);
  vi.spyOn(toast, 'error').mockImplementation(() => '' as never);
  mocks.skills.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.connectors.list.mockResolvedValue({ items: [], nextCursor: null });
  mocks.connectors.getBatch.mockResolvedValue({ failedIds: [], items: [] });
  mocks.connectors.getGovernance.mockResolvedValue({
    doc: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: null } },
    managedActive: false,
    revision: 0,
  });
  mocks.connectors.updateBuiltinToolPolicy.mockResolvedValue({ revision: 1 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAdminGlobalToolScope', () => {
  describe('capabilities', () => {
    it('exposes platform SKILL_* / CONNECTOR_* capabilities from admin access', async () => {
      const { result } = renderScope('skill');
      await waitFor(() => expect(result.current.capabilities.canCreateSkill).toBe(true));
      expect(result.current.capabilities).toEqual({
        canCreateConnector: true,
        canCreateSkill: true,
        canDeleteConnector: true,
        canDeleteSkill: true,
        canUpdateConnector: true,
        canUpdateSkill: true,
      });
    });

    it('read-only without mutation permissions', async () => {
      accessMocks.permissions = ['platform_skill:read:all', 'platform_connector:read:all'];
      const { result } = renderScope('skill');
      await waitFor(() => expect(result.current.listLoading).toBe(false));
      expect(result.current.capabilities).toEqual({
        canCreateConnector: false,
        canCreateSkill: false,
        canDeleteConnector: false,
        canDeleteSkill: false,
        canUpdateConnector: false,
        canUpdateSkill: false,
      });
    });

    it('requires PUBLISH alongside create/delete/update for immediate operations', async () => {
      // Mutation grants without publish → all false (immediate ops always publish).
      accessMocks.permissions = [
        'platform_skill:create:all',
        'platform_skill:update:all',
        'platform_skill:delete:all',
        'platform_connector:create:all',
        'platform_connector:update:all',
        'platform_connector:delete:all',
      ];
      const { result } = renderScope('skill');
      await waitFor(() => expect(result.current.listLoading).toBe(false));
      expect(result.current.capabilities).toEqual({
        canCreateConnector: false,
        canCreateSkill: false,
        canDeleteConnector: false,
        canDeleteSkill: false,
        canUpdateConnector: false,
        canUpdateSkill: false,
      });
    });

    it('create works when create+publish are granted without update/delete', async () => {
      accessMocks.permissions = [
        'platform_skill:create:all',
        'platform_skill:publish:all',
        'platform_connector:create:all',
        'platform_connector:publish:all',
      ];
      const { result } = renderScope('skill');
      await waitFor(() => expect(result.current.listLoading).toBe(false));
      expect(result.current.capabilities).toEqual({
        canCreateConnector: true,
        canCreateSkill: true,
        canDeleteConnector: false,
        canDeleteSkill: false,
        canUpdateConnector: false,
        canUpdateSkill: false,
      });
    });
  });

  describe('view isolation (AI-05)', () => {
    it('does not call skills service or surface skill errors in connector view', async () => {
      accessMocks.permissions = ['platform_connector:read:all'];
      mocks.skills.list.mockRejectedValue(new Error('PLATFORM_PERMISSION_DENIED: skill'));
      mocks.connectors.list.mockResolvedValue({
        items: [
          {
            description: null,
            displayName: 'Jira',
            enabled: true,
            id: 'conn-1',
            key: 'jira',
            revision: 1,
            sort: 0,
            status: 'published',
          },
        ],
        nextCursor: null,
      });
      mocks.connectors.getBatch.mockResolvedValue({
        failedIds: [],
        items: [connectorDetail()],
      });

      const { result } = renderScope('connector');
      await waitFor(() => expect(result.current.listLoading).toBe(false));

      expect(mocks.skills.list).not.toHaveBeenCalled();
      expect(result.current.listError).toBeUndefined();
      expect(result.current.connectors.some((c) => c.id === 'conn-1')).toBe(true);
    });
  });

  describe('catalog pagination', () => {
    it('traverses all skill list cursors beyond 100 items', async () => {
      const page1 = Array.from({ length: 100 }, (_, i) =>
        skillRow({
          displayName: `Skill ${i}`,
          id: `skill-${i}`,
          skillKey: `uploaded.skill-${i}`,
        }),
      );
      const page2 = [
        skillRow({
          displayName: 'Skill 100',
          id: 'skill-100',
          skillKey: 'uploaded.skill-100',
        }),
      ];
      mocks.skills.list
        .mockResolvedValueOnce({ items: page1, nextCursor: 'cursor-page-2' })
        .mockResolvedValueOnce({ items: page2, nextCursor: null });

      const { result } = renderScope('skill');
      await waitFor(() => expect(result.current.orgSkills).toHaveLength(101));
      expect(mocks.skills.list).toHaveBeenCalledTimes(2);
      expect(mocks.skills.list).toHaveBeenNthCalledWith(1, { cursor: undefined, limit: 100 });
      expect(mocks.skills.list).toHaveBeenNthCalledWith(2, {
        cursor: 'cursor-page-2',
        limit: 100,
      });
    });

    it('loads connector details in batches of 50 for catalogs larger than 50', async () => {
      const listItems = Array.from({ length: 51 }, (_, i) => ({
        description: null,
        displayName: `Conn ${i}`,
        enabled: true,
        id: `conn-${i}`,
        key: `conn-key-${i}`,
        revision: 1,
        sort: i,
        status: 'published' as const,
      }));
      mocks.connectors.list.mockResolvedValue({ items: listItems, nextCursor: null });
      mocks.connectors.getBatch.mockImplementation(async ({ ids }: { ids: string[] }) => ({
        failedIds: [],
        items: ids.map((id) =>
          connectorDetail({
            draft: {
              ...connectorDetail().draft,
              displayName: id,
              id,
              key: id,
            },
          }),
        ),
      }));

      const { result } = renderScope('connector');
      await waitFor(() => expect(result.current.connectors.length).toBeGreaterThanOrEqual(51));
      expect(mocks.connectors.getBatch).toHaveBeenCalledTimes(2);
      expect(mocks.connectors.getBatch.mock.calls[0][0].ids).toHaveLength(50);
      expect(mocks.connectors.getBatch.mock.calls[1][0].ids).toHaveLength(1);
    });
  });

  describe('orgSkills', () => {
    it('maps only uploaded non-archived catalog rows into SkillListItem shape', async () => {
      mocks.skills.list.mockResolvedValue({
        items: [
          skillRow({ displayName: 'Uploaded One', id: 'row-1', skillKey: 'uploaded.one' }),
          skillRow({
            displayName: 'Archived',
            id: 'row-2',
            skillKey: 'uploaded.archived',
            status: 'archived',
          }),
          skillRow({
            displayName: 'Builtin Override',
            id: 'row-3',
            skillKey: 'lobe-artifacts',
            source: 'builtin',
          }),
        ],
        nextCursor: null,
      });

      const { result } = renderScope('skill');

      await waitFor(() => expect(result.current.orgSkills).toHaveLength(1));
      expect(result.current.orgSkills[0]).toMatchObject({
        description: 'An org skill',
        id: 'row-1',
        identifier: 'uploaded.one',
        name: 'Uploaded One',
        source: 'user',
      });
      expect(result.current.orgSkills[0].manifest).toMatchObject({ name: 'Uploaded One' });
    });
  });

  describe('builtin skill availability', () => {
    it('reports enabled/default when the builtin has no catalog row', async () => {
      const { result } = renderScope('skill');
      await waitFor(() => expect(mocks.skills.list).toHaveBeenCalled());

      expect(result.current.isBuiltinSkillEnabled('lobe-artifacts')).toBe(true);
      expect(result.current.getBuiltinSkillDistribution('lobe-artifacts')).toBe('default');
    });

    it('maps optional/archived/mandatory catalog rows to availability + distribution', async () => {
      mocks.skills.list.mockResolvedValue({
        items: [
          skillRow({
            distribution: 'optional',
            id: 'row-opt',
            skillKey: 'lobe-artifacts',
            source: 'builtin',
          }),
          skillRow({
            id: 'row-arch',
            skillKey: 'skill.archived',
            source: 'builtin',
            status: 'archived',
          }),
          skillRow({
            distribution: 'mandatory',
            id: 'row-mand',
            skillKey: 'skill.mandatory',
            source: 'builtin',
          }),
        ],
        nextCursor: null,
      });

      const { result } = renderScope('skill');
      await waitFor(() =>
        expect(result.current.getBuiltinSkillDistribution('lobe-artifacts')).toBe('optional'),
      );

      expect(result.current.isBuiltinSkillEnabled('lobe-artifacts')).toBe(false);
      expect(result.current.isBuiltinSkillEnabled('skill.archived')).toBe(false);
      expect(result.current.getBuiltinSkillDistribution('skill.archived')).toBe('optional');
      expect(result.current.isBuiltinSkillEnabled('skill.mandatory')).toBe(true);
      expect(result.current.getBuiltinSkillDistribution('skill.mandatory')).toBe('mandatory');
    });
  });

  describe('toggleBuiltinSkill', () => {
    it('materializes a builtin override row (mode create) when no catalog row exists', async () => {
      mocks.skills.applyImmediate.mockResolvedValue({
        draft: { id: 'created-row' },
        publishError: null,
        published: true,
      });

      const { result } = renderScope('skill');
      await waitFor(() => expect(mocks.skills.list).toHaveBeenCalled());

      await act(async () => {
        await result.current.toggleBuiltinSkill('lobe-artifacts', false);
      });

      expect(mocks.skills.get).not.toHaveBeenCalled();
      expect(mocks.skills.applyImmediate).toHaveBeenCalledTimes(1);
      const input = mocks.skills.applyImmediate.mock.calls[0][0];
      expect(input).toMatchObject({
        allowBuiltinOverride: true,
        distribution: 'optional',
        enabled: true,
        mode: 'create',
        skillKey: 'lobe-artifacts',
      });

      const bundled = bundledBuiltinSkills.find((skill) => skill.identifier === 'lobe-artifacts')!;
      // applyImmediate version payload carries the bundled builtin content (trimmed).
      expect(input.version).toMatchObject({ content: bundled.content.trim(), version: '1.0.0' });
      expect(input.displayName).toBe(bundled.name);
    });

    it('updates an existing catalog row with the CAS tokens from get()', async () => {
      mocks.skills.list.mockResolvedValue({
        items: [
          skillRow({
            distribution: 'optional',
            id: 'row-artifacts',
            skillKey: 'lobe-artifacts',
            source: 'builtin',
          }),
        ],
        nextCursor: null,
      });
      mocks.skills.get.mockResolvedValue({
        baseRevision: 7,
        draft: skillRow({ id: 'row-artifacts', skillKey: 'lobe-artifacts' }),
        draftToken: 'a'.repeat(64),
        latestVersion: null,
        publishedVersion: null,
      });
      mocks.skills.applyImmediate.mockResolvedValue({
        draft: { id: 'row-artifacts' },
        publishError: null,
        published: true,
      });

      const { result } = renderScope('skill');
      await waitFor(() =>
        expect(result.current.getBuiltinSkillDistribution('lobe-artifacts')).toBe('optional'),
      );

      await act(async () => {
        await result.current.toggleBuiltinSkill('lobe-artifacts', true);
      });

      expect(mocks.skills.get).toHaveBeenCalledWith({ id: 'row-artifacts' });
      expect(mocks.skills.applyImmediate).toHaveBeenCalledTimes(1);
      expect(mocks.skills.applyImmediate.mock.calls[0][0]).toMatchObject({
        distribution: 'default',
        expectedDraftToken: 'a'.repeat(64),
        expectedRevision: 7,
        id: 'row-artifacts',
        mode: 'update',
      });
    });
  });

  describe('connectors', () => {
    it('synthesizes read-only builtin rows and maps platform rows with tool permissions', async () => {
      mocks.connectors.list.mockResolvedValue({
        items: [{ id: 'conn-1', key: 'jira' }],
        nextCursor: null,
      });
      mocks.connectors.getBatch.mockResolvedValue({
        failedIds: [],
        items: [connectorDetail()],
      });

      const { result } = renderScope('connector');

      await waitFor(() =>
        expect(result.current.connectors.some((c) => c.id === 'conn-1')).toBe(true),
      );
      expect(mocks.connectors.getBatch).toHaveBeenCalledWith({ ids: ['conn-1'] });

      const builtinRows = result.current.connectors.filter((c) =>
        c.id.startsWith('admin-builtin:'),
      );
      expect(builtinRows.length).toBeGreaterThan(0);
      for (const row of builtinRows) {
        expect(row.sourceType).toBe('builtin');
        // Governance loaded → builtin matrix is editable org-wide.
        expect(result.current.isConnectorReadOnly(row)).toBe(false);
      }
      const builtinTool = builtinRows.find((row) => row.tools.length > 0)?.tools[0];
      expect(builtinTool?.id.startsWith('admin-builtin:')).toBe(true);
      expect(builtinTool?.permission).toBe(ConnectorToolPermission.auto);

      const platformRow = result.current.connectors.find((c) => c.id === 'conn-1')!;
      expect(platformRow).toMatchObject({
        identifier: 'jira',
        mcpConnectionType: 'http',
        mcpServerUrl: 'https://mcp.example.com/jira',
        name: 'Jira',
        sourceType: 'custom',
        status: 'connected',
      });
      expect(result.current.isConnectorReadOnly(platformRow)).toBe(false);

      const permissionByKey = Object.fromEntries(
        platformRow.tools.map((tool) => [tool.toolName, tool.permission]),
      );
      expect(permissionByKey).toEqual({
        create_issue: ConnectorToolPermission.needs_approval,
        delete_issue: ConnectorToolPermission.disabled,
        search_issues: ConnectorToolPermission.auto,
      });
      expect(platformRow.tools[0].id).toBe('platform:conn-1:create_issue');
    });

    it('updateToolPermission(disabled) patches the tool policy to deny via CAS applyImmediate', async () => {
      mocks.connectors.list.mockResolvedValue({
        items: [{ id: 'conn-1', key: 'jira' }],
        nextCursor: null,
      });
      mocks.connectors.getBatch.mockResolvedValue({
        failedIds: [],
        items: [connectorDetail()],
      });
      mocks.connectors.applyImmediate.mockResolvedValue({
        draft: { id: 'conn-1' },
        publishError: null,
        published: true,
      });

      const { result } = renderScope('connector');
      await waitFor(() =>
        expect(result.current.connectors.some((c) => c.id === 'conn-1')).toBe(true),
      );

      await act(async () => {
        await result.current.updateToolPermission(
          'platform:conn-1:create_issue',
          ConnectorToolPermission.disabled,
        );
      });

      expect(mocks.connectors.applyImmediate).toHaveBeenCalledTimes(1);
      const input = mocks.connectors.applyImmediate.mock.calls[0][0];
      expect(input).toMatchObject({
        expectedDraftToken: 'c'.repeat(64),
        expectedRevision: 5,
        id: 'conn-1',
        mode: 'update',
      });
      const patched = Object.fromEntries(
        input.tools.map((tool: { platformPolicy: string; toolKey: string }) => [
          tool.toolKey,
          tool.platformPolicy,
        ]),
      );
      expect(patched).toEqual({
        create_issue: 'deny',
        delete_issue: 'deny',
        search_issues: 'allow',
      });
      const patchedTool = input.tools.find(
        (tool: { toolKey: string }) => tool.toolKey === 'create_issue',
      );
      expect(patchedTool.requiresConfirmation).toBe(false);
    });

    it('updateToolsPermission writes a group in ONE CAS applyImmediate', async () => {
      mocks.connectors.list.mockResolvedValue({
        items: [{ id: 'conn-1', key: 'jira' }],
        nextCursor: null,
      });
      mocks.connectors.getBatch.mockResolvedValue({
        failedIds: [],
        items: [connectorDetail()],
      });
      mocks.connectors.applyImmediate.mockResolvedValue({
        draft: { id: 'conn-1' },
        publishError: null,
        published: true,
      });

      const { result } = renderScope('connector');
      await waitFor(() =>
        expect(result.current.connectors.some((c) => c.id === 'conn-1')).toBe(true),
      );

      await act(async () => {
        await result.current.updateToolsPermission!(
          [
            'platform:conn-1:create_issue',
            'platform:conn-1:search_issues',
            'platform:conn-1:delete_issue',
          ],
          ConnectorToolPermission.needs_approval,
        );
      });

      // One write, not one per tool — N writes would race the same revision.
      expect(mocks.connectors.applyImmediate).toHaveBeenCalledTimes(1);
      const input = mocks.connectors.applyImmediate.mock.calls[0][0];
      expect(input).toMatchObject({
        expectedDraftToken: 'c'.repeat(64),
        expectedRevision: 5,
        id: 'conn-1',
        mode: 'update',
      });
      expect(
        input.tools.map(
          (tool: { platformPolicy: string; requiresConfirmation: boolean; toolKey: string }) => [
            tool.toolKey,
            tool.platformPolicy,
            tool.requiresConfirmation,
          ],
        ),
      ).toEqual([
        ['create_issue', 'allow', true],
        ['search_issues', 'allow', true],
        ['delete_issue', 'allow', true],
      ]);
    });

    it('updateToolsPermission writes builtin group policies in ONE governance update', async () => {
      const { result } = renderScope('connector');
      await waitFor(() => expect(result.current.listLoading).toBe(false));

      await act(async () => {
        await result.current.updateToolsPermission!(
          [
            'admin-builtin:lobe-web-browsing:search',
            'admin-builtin:lobe-web-browsing:crawl:multi',
            'admin-builtin:lobe-image-designer:generate',
          ],
          ConnectorToolPermission.disabled,
        );
      });

      expect(mocks.connectors.updateBuiltinToolPolicy).toHaveBeenCalledTimes(1);
      expect(mocks.connectors.updateBuiltinToolPolicy.mock.calls[0][0]).toMatchObject({
        expectedRevision: 0,
        policies: {
          'lobe-image-designer': { generate: ConnectorToolPermission.disabled },
          // Tool names may contain ':' — the id split must keep them intact.
          'lobe-web-browsing': {
            'crawl:multi': ConnectorToolPermission.disabled,
            'search': ConnectorToolPermission.disabled,
          },
        },
      });
      expect(mocks.connectors.applyImmediate).not.toHaveBeenCalled();
    });

    it('surfaces partial connector detail failures via listError', async () => {
      mocks.connectors.list.mockResolvedValue({
        items: [
          { id: 'conn-1', key: 'jira' },
          { id: 'conn-2', key: 'slack' },
        ],
        nextCursor: null,
      });
      mocks.connectors.getBatch.mockResolvedValue({
        failedIds: ['conn-2'],
        items: [connectorDetail()],
      });

      const { result } = renderScope('connector');

      await waitFor(() =>
        expect(result.current.connectors.some((c) => c.id === 'conn-1')).toBe(true),
      );
      expect(result.current.listError).toBeInstanceOf(Error);
      expect(String(result.current.listError)).toMatch(/1 connectors failed to load/i);
      expect(result.current.connectors.some((c) => c.id === 'conn-2')).toBe(false);
    });

    it('coalesces governance toasts by failure episode and resets after recovery', async () => {
      const governanceErrorA = new Error('governance unavailable A');
      const governanceErrorB = new Error('governance unavailable B');
      const governanceErrorC = new Error('governance unavailable C');
      mocks.connectors.getGovernance
        .mockRejectedValueOnce(governanceErrorA)
        .mockRejectedValueOnce(governanceErrorB)
        .mockResolvedValueOnce({
          doc: { builtinToolPolicies: {}, sharedAuthorization: { ownerUserId: null } },
          managedActive: false,
          revision: 0,
        })
        .mockRejectedValueOnce(governanceErrorC);

      const { result } = renderScope('connector');

      await waitFor(() => expect(result.current.listError).toBe(governanceErrorA));
      expect(result.current.listLoading).toBe(false);
      expect(toast.error).toHaveBeenCalledWith('aiToolSettings.connectors.governanceLoadFailed');
      expect(result.current.connectorNotice).toBeTruthy();

      act(() => result.current.retry());
      await waitFor(() => expect(result.current.listError).toBe(governanceErrorB));
      expect(result.current.connectorNotice).toBeTruthy();
      expect(toast.error).toHaveBeenCalledTimes(1);

      act(() => result.current.retry());
      await waitFor(() => expect(result.current.listError).toBeUndefined());
      expect(result.current.connectorNotice).toBeUndefined();

      act(() => result.current.retry());
      await waitFor(() => expect(result.current.listError).toBe(governanceErrorC));
      expect(result.current.connectorNotice).toBeTruthy();
      expect(toast.error).toHaveBeenCalledTimes(2);
    });
  });

  describe('submitCustomConnector', () => {
    it('rejects stdio transports', async () => {
      const { result } = renderScope('connector');
      await waitFor(() => expect(mocks.connectors.list).toHaveBeenCalled());

      await expect(
        result.current.submitCustomConnector({ identifier: 'local-tool', transport: 'stdio' }),
      ).rejects.toThrow(/CONNECTOR_HTTP_ONLY/);
      expect(mocks.connectors.applyImmediate).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledWith('connectorCatalog.errors.generic');
    });

    it('creates with credentialMode none, discovers tools, then publishes them as allowed', async () => {
      mocks.connectors.applyImmediate
        .mockResolvedValueOnce({ draft: { id: 'conn-new' }, publishError: null, published: true })
        .mockResolvedValueOnce({ draft: { id: 'conn-new' }, publishError: null, published: true });
      mocks.connectors.discover.mockResolvedValue({
        tools: [
          {
            description: 'Does the thing',
            displayName: 'Do Thing',
            inputSchema: {},
            outputSchema: null,
            platformPolicy: 'allow',
            requiresConfirmation: false,
            riskLevel: 'low',
            sort: 0,
            toolKey: 'do_thing',
          },
        ],
      });
      mocks.connectors.get.mockResolvedValue(
        connectorDetail({
          baseRevision: 1,
          draft: { ...connectorDetail().draft, id: 'conn-new', key: 'my-connector', tools: [] },
          draftToken: 'd'.repeat(64),
        }),
      );

      const { result } = renderScope('connector');
      await waitFor(() => expect(mocks.connectors.list).toHaveBeenCalled());

      await act(async () => {
        await result.current.submitCustomConnector({
          identifier: 'My Connector',
          serverUrl: 'https://mcp.example.com/mcp',
          transport: 'http',
        });
      });

      expect(mocks.connectors.applyImmediate).toHaveBeenCalledTimes(2);
      expect(mocks.connectors.applyImmediate.mock.calls[0][0]).toMatchObject({
        credentialMode: 'none',
        displayName: 'My Connector',
        enabled: true,
        endpoint: 'https://mcp.example.com/mcp',
        key: 'my-connector',
        mode: 'create',
        transport: 'http',
      });
      expect(mocks.connectors.discover).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'conn-new' }),
      );
      expect(mocks.connectors.get).toHaveBeenCalledWith({ id: 'conn-new' });

      const update = mocks.connectors.applyImmediate.mock.calls[1][0];
      expect(update).toMatchObject({
        expectedDraftToken: 'd'.repeat(64),
        expectedRevision: 1,
        id: 'conn-new',
        mode: 'update',
      });
      expect(update.tools).toEqual([
        expect.objectContaining({
          id: 'my-connector-0',
          platformPolicy: 'allow',
          requiresConfirmation: false,
          toolKey: 'do_thing',
        }),
      ]);
    });

    it('warns and rejects when discovery fails after create (AI-06 / XT-001)', async () => {
      mocks.connectors.applyImmediate.mockResolvedValueOnce({
        draft: { id: 'conn-new' },
        publishError: null,
        published: true,
      });
      mocks.connectors.discover.mockRejectedValueOnce(new Error('endpoint unreachable'));

      const { result } = renderScope('connector');
      await waitFor(() => expect(mocks.connectors.list).toHaveBeenCalled());

      await act(async () => {
        await expect(
          result.current.submitCustomConnector({
            identifier: 'My Connector',
            serverUrl: 'https://mcp.example.com/mcp',
            transport: 'http',
          }),
        ).rejects.toThrow(/CONNECTOR_CREATE_DISCOVERY_FAILED/);
      });

      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringMatching(/createdDiscoveryFailed|discovery failed|advanced catalog/i),
      );
      // Create committed once; tools update never ran.
      expect(mocks.connectors.applyImmediate).toHaveBeenCalledTimes(1);
    });

    it('warns and rejects when create returns published:false (AI-06)', async () => {
      mocks.connectors.applyImmediate.mockResolvedValueOnce({
        draft: { id: 'conn-soft' },
        publishError: 'validation_failed',
        published: false,
      });

      const { result } = renderScope('connector');
      await waitFor(() => expect(mocks.connectors.list).toHaveBeenCalled());

      await act(async () => {
        await expect(
          result.current.submitCustomConnector({
            identifier: 'Soft Fail',
            serverUrl: 'https://mcp.example.com/mcp',
            transport: 'http',
          }),
        ).rejects.toThrow(/CONNECTOR_CREATE_INCOMPLETE/);
      });

      expect(toast.warning).toHaveBeenCalled();
      expect(mocks.connectors.discover).not.toHaveBeenCalled();
    });
  });

  describe('deleteConnector (XT-001)', () => {
    it('toasts connectorCatalog.errors.generic once when unpublished deleteDraft rejects', async () => {
      mocks.connectors.list.mockResolvedValue({
        items: [{ id: 'conn-draft', key: 'draft-jira' }],
        nextCursor: null,
      });
      mocks.connectors.getBatch.mockResolvedValue({
        failedIds: [],
        items: [
          connectorDetail({
            draft: {
              ...connectorDetail().draft,
              id: 'conn-draft',
              key: 'draft-jira',
              status: 'draft',
            },
            published: null,
          }),
        ],
      });
      mocks.connectors.deleteDraft.mockRejectedValueOnce(new Error('409 Conflict'));

      const { result } = renderScope('connector');
      await waitFor(() =>
        expect(result.current.connectors.some((c) => c.id === 'conn-draft')).toBe(true),
      );

      await act(async () => {
        await expect(result.current.deleteConnector('conn-draft')).rejects.toThrow(/409/);
      });

      expect(mocks.connectors.deleteDraft).toHaveBeenCalledTimes(1);
      expect(mocks.connectors.archiveImmediate).not.toHaveBeenCalled();
      expect(toast.error).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith('connectorCatalog.errors.generic');
      expect(toast.success).not.toHaveBeenCalled();
    });
  });
});
