// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type {
  PlatformAgentTemplateRecord,
  PlatformTaskTemplateRecord,
} from '@/database/models/platform';
import { TASK_TEMPLATE_LIBRARY } from '@/server/services/taskTemplate/library';

import { builtInAgentTemplatesForLocale } from '../routers/admin/builtInAgentTemplates';
import {
  matchingCatalogIdentifiers,
  overlayAgentTemplateLocale,
  overlayTaskTemplateLocale,
} from './templateCatalogLocalization';

const now = new Date('2024-06-01T00:00:00.000Z');

const agentRow = (
  overrides: Partial<PlatformAgentTemplateRecord> = {},
): PlatformAgentTemplateRecord => ({
  avatar: '🤖',
  backgroundColor: '#fff',
  createdAt: now,
  description: '',
  enabled: true,
  id: 'agent-row-1',
  identifier: 'agent-01',
  revision: 4,
  sortOrder: 7,
  source: 'builtin',
  systemRole: '',
  tags: ['writing'],
  title: '',
  updatedAt: now,
  ...overrides,
});

const taskRow = (
  overrides: Partial<PlatformTaskTemplateRecord> = {},
): PlatformTaskTemplateRecord => ({
  category: 'engineering',
  connectors: [],
  createdAt: now,
  cronPattern: '30 9 * * 1',
  description: '',
  enabled: true,
  icon: null,
  id: 'task-row-1',
  identifier: 'mfg-process-yield-weekly',
  instruction: '',
  interests: ['operations'],
  revision: 4,
  sortOrder: 3,
  source: 'market',
  title: '',
  updatedAt: now,
  ...overrides,
});

const enAgent = builtInAgentTemplatesForLocale('en-US')[0]!;
const zhAgent = builtInAgentTemplatesForLocale('zh-CN')[0]!;
const enTask = TASK_TEMPLATE_LIBRARY[0]!.text['en-US'];
const zhTask = TASK_TEMPLATE_LIBRARY[0]!.text['zh-CN'];
const taskIdentifier = TASK_TEMPLATE_LIBRARY[0]!.identifier;

describe('overlayAgentTemplateLocale', () => {
  it('overlays an untouched en-US built-in row to zh-CN title and systemRole', () => {
    const row = agentRow({
      description: enAgent.description,
      systemRole: enAgent.systemRole,
      title: enAgent.title,
    });

    const [overlaid] = overlayAgentTemplateLocale([row], 'zh-CN');
    expect(overlaid).toMatchObject({
      description: zhAgent.description,
      id: row.id,
      identifier: row.identifier,
      revision: row.revision,
      sortOrder: row.sortOrder,
      source: row.source,
      systemRole: zhAgent.systemRole,
      tags: row.tags,
      title: zhAgent.title,
    });
    expect(overlaid.systemRole).not.toBe(enAgent.systemRole);
    expect(overlaid.title).not.toBe(enAgent.title);
  });

  it('overlays a zh-CN catalog row to en-US when locale is en-US', () => {
    const row = agentRow({
      description: zhAgent.description,
      systemRole: zhAgent.systemRole,
      title: zhAgent.title,
    });

    const [overlaid] = overlayAgentTemplateLocale([row], 'en-US');
    expect(overlaid.title).toBe(enAgent.title);
    expect(overlaid.systemRole).toBe(enAgent.systemRole);
  });

  it('leaves an edited row and an unknown identifier unchanged', () => {
    const edited = agentRow({
      description: enAgent.description,
      id: 'edited',
      systemRole: enAgent.systemRole,
      title: 'Operator rewrite',
    });
    const unknown = agentRow({
      id: 'unknown',
      identifier: 'custom-manual',
      systemRole: enAgent.systemRole,
      title: enAgent.title,
    });

    const result = overlayAgentTemplateLocale([edited, unknown], 'zh-CN');
    expect(result[0]).toBe(edited);
    expect(result[1]).toBe(unknown);
  });

  it('preserves other fields and array order, including a mixed page', () => {
    const untouched = agentRow({
      description: `  ${enAgent.description}  `,
      id: 'first',
      systemRole: ` ${enAgent.systemRole} `,
      title: ` ${enAgent.title} `,
    });
    const manual = agentRow({
      id: 'second',
      identifier: 'my-custom',
      source: 'manual',
      systemRole: 'Stay put.',
      title: 'Custom card',
    });

    const result = overlayAgentTemplateLocale([untouched, manual], 'zh-CN');
    expect(result.map((row) => row.id)).toEqual(['first', 'second']);
    expect(result[0]).toMatchObject({
      avatar: untouched.avatar,
      backgroundColor: untouched.backgroundColor,
      enabled: true,
      revision: 4,
      sortOrder: 7,
      source: 'builtin',
      tags: ['writing'],
      title: zhAgent.title,
    });
    expect(result[0]?.createdAt).toBe(untouched.createdAt);
    expect(result[1]).toBe(manual);
  });

  it('falls back like bootstrap for an unknown locale', () => {
    const row = agentRow({
      description: zhAgent.description,
      systemRole: zhAgent.systemRole,
      title: zhAgent.title,
    });

    const [overlaid] = overlayAgentTemplateLocale([row], 'zz-ZZ');
    expect(overlaid.title).toBe(enAgent.title);
    expect(overlaid.systemRole).toBe(enAgent.systemRole);
  });

  it('returns the original array when every row already matches the target locale', () => {
    const row = agentRow({
      description: enAgent.description,
      systemRole: enAgent.systemRole,
      title: enAgent.title,
    });
    const rows = [row];
    expect(overlayAgentTemplateLocale(rows, 'en-US')).toBe(rows);
  });
});

describe('matchingCatalogIdentifiers', () => {
  it('returns agent identifiers whose zh-CN title contains the query, case-insensitive', () => {
    expect(matchingCatalogIdentifiers('agent', 'zh-CN', zhAgent.title)).toContain(
      enAgent.identifier,
    );
    expect(matchingCatalogIdentifiers('agent', 'en-US', enAgent.title.toUpperCase())).toContain(
      enAgent.identifier,
    );
  });

  it('returns task identifiers whose zh-CN title or description contains the query', () => {
    expect(matchingCatalogIdentifiers('task', 'zh-CN', zhTask.title)).toEqual([taskIdentifier]);
    expect(matchingCatalogIdentifiers('task', 'zh-CN', '良率数据对照')).toEqual([taskIdentifier]);
  });

  it('returns nothing for an unknown query or a blank query', () => {
    expect(matchingCatalogIdentifiers('agent', 'zh-CN', 'zzz-no-such-catalog-phrase')).toEqual([]);
    expect(matchingCatalogIdentifiers('task', 'en-US', '   ')).toEqual([]);
  });
});

describe('overlayTaskTemplateLocale', () => {
  it('overlays an untouched English library row to zh-CN title, description and instruction', () => {
    const row = taskRow({
      description: enTask.description,
      identifier: taskIdentifier,
      instruction: enTask.instruction,
      title: enTask.title,
    });

    const [overlaid] = overlayTaskTemplateLocale([row], 'zh-CN');
    expect(overlaid).toMatchObject({
      cronPattern: row.cronPattern,
      description: zhTask.description,
      id: row.id,
      identifier: taskIdentifier,
      instruction: zhTask.instruction,
      revision: row.revision,
      title: zhTask.title,
    });
    expect(overlaid.title).not.toBe(enTask.title);
  });

  it('overlays a zh-CN catalog row to en-US when locale is en-US', () => {
    const row = taskRow({
      description: zhTask.description,
      identifier: taskIdentifier,
      instruction: zhTask.instruction,
      title: zhTask.title,
    });

    const [overlaid] = overlayTaskTemplateLocale([row], 'en-US');
    expect(overlaid.title).toBe(enTask.title);
    expect(overlaid.description).toBe(enTask.description);
    expect(overlaid.instruction).toBe(enTask.instruction);
  });

  it('leaves an edited row and an unknown identifier unchanged', () => {
    const edited = taskRow({
      description: enTask.description,
      id: 'edited',
      identifier: taskIdentifier,
      instruction: 'Operator rewrite',
      title: enTask.title,
    });
    const unknown = taskRow({
      description: enTask.description,
      id: 'unknown',
      identifier: 'not-in-library',
      instruction: enTask.instruction,
      title: enTask.title,
    });

    const result = overlayTaskTemplateLocale([edited, unknown], 'zh-CN');
    expect(result[0]).toBe(edited);
    expect(result[1]).toBe(unknown);
  });

  it('preserves other fields and array order', () => {
    const untouched = taskRow({
      connectors: [{ identifier: 'gmail', required: true, source: 'lobehub' }],
      description: enTask.description,
      id: 'first',
      identifier: taskIdentifier,
      instruction: enTask.instruction,
      title: enTask.title,
    });
    const manual = taskRow({
      id: 'second',
      identifier: 'custom-digest',
      source: 'manual',
      title: 'Custom digest',
      instruction: 'Stay put.',
      description: 'Manual copy',
    });

    const result = overlayTaskTemplateLocale([untouched, manual], 'zh-CN');
    expect(result.map((row) => row.id)).toEqual(['first', 'second']);
    expect(result[0]).toMatchObject({
      category: untouched.category,
      connectors: untouched.connectors,
      cronPattern: untouched.cronPattern,
      enabled: true,
      icon: null,
      interests: untouched.interests,
      revision: 4,
      sortOrder: 3,
      source: 'market',
      title: zhTask.title,
    });
    expect(result[1]).toBe(manual);
  });

  it('falls back like bootstrap for an unknown locale', () => {
    const row = taskRow({
      description: zhTask.description,
      identifier: taskIdentifier,
      instruction: zhTask.instruction,
      title: zhTask.title,
    });

    const [overlaid] = overlayTaskTemplateLocale([row], 'zz-ZZ');
    expect(overlaid.title).toBe(enTask.title);
    expect(overlaid.description).toBe(enTask.description);
    expect(overlaid.instruction).toBe(enTask.instruction);
  });
});
