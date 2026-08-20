// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { fetchBuiltInAgentTemplatesForImport } from './agentTemplatesSupport';
import {
  builtInAgentTemplatesForImport,
  builtInAgentTemplatesFromCatalog,
} from './builtInAgentTemplates';

describe('builtInAgentTemplatesForImport', () => {
  it('loads 40 en-US examples from the suggestQuestions source without duplicating copy', () => {
    const rows = builtInAgentTemplatesForImport('en-US');
    expect(rows).toHaveLength(40);
    expect(rows[0]).toMatchObject({
      description: '',
      identifier: 'agent-01',
      title: 'Help me become a better writer',
    });
    expect(rows[0]?.systemRole.length).toBeGreaterThan(20);
    expect(rows[39]?.identifier).toBe('agent-40');
  });

  it('resolves zh-CN copy and falls back to en-US for unknown locales', () => {
    const zh = builtInAgentTemplatesForImport('zh-CN');
    const en = builtInAgentTemplatesForImport('en-US');
    const fallback = builtInAgentTemplatesForImport('fr-FR');

    expect(zh).toHaveLength(40);
    expect(zh[0]?.identifier).toBe('agent-01');
    expect(zh[0]?.title).not.toBe(en[0]?.title);
    expect(fallback[0]?.title).toBe(en[0]?.title);
  });

  it('keeps a slot for every agent.NN when copy is missing so skipped can be counted', () => {
    const rows = builtInAgentTemplatesFromCatalog({
      'agent.01.prompt': 'You are a writer.',
      'agent.01.title': 'Writer',
    });
    expect(rows).toHaveLength(40);
    expect(rows[0]).toMatchObject({
      identifier: 'agent-01',
      systemRole: 'You are a writer.',
      title: 'Writer',
    });
    expect(rows.filter((row) => !row.title || !row.systemRole)).toHaveLength(39);
  });
});

describe('fetchBuiltInAgentTemplatesForImport', () => {
  it('imports the real 40-slot catalogs with skipped 0', () => {
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'en-US' })).toMatchObject({
      skipped: 0,
    });
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'en-US' }).rows).toHaveLength(40);
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'zh-CN' }).rows).toHaveLength(40);
  });
});
