// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { fetchBuiltInAgentTemplatesForImport } from './agentTemplatesSupport';
import {
  builtInAgentTemplatesForImport,
  builtInAgentTemplatesFromCatalog,
  resolveBuiltInAgentTemplateLocale,
} from './builtInAgentTemplates';

const EN_US_AGENT_01_TITLE = 'Help me become a better writer';
const ZH_CN_AGENT_01_TITLE = '帮助我成为更好的写作者';
const ZH_TW_AGENT_01_TITLE = '幫助我成為更好的作家';
const JA_JP_AGENT_01_TITLE = 'もっと上手に書けるようになりたい';

describe('resolveBuiltInAgentTemplateLocale', () => {
  it('matches an exact catalog tag and a language-region tag', () => {
    expect(resolveBuiltInAgentTemplateLocale('ja-JP')).toBe('ja-JP');
    expect(resolveBuiltInAgentTemplateLocale('zh-TW')).toBe('zh-TW');
    expect(resolveBuiltInAgentTemplateLocale('zh_cn')).toBe('zh-CN');
    expect(resolveBuiltInAgentTemplateLocale('zh-Hant-TW')).toBe('zh-TW');
  });

  it('matches by language with Chinese script/region hints', () => {
    expect(resolveBuiltInAgentTemplateLocale('zh')).toBe('zh-CN');
    expect(resolveBuiltInAgentTemplateLocale('zh-Hant')).toBe('zh-TW');
    expect(resolveBuiltInAgentTemplateLocale('zh-HK')).toBe('zh-TW');
    expect(resolveBuiltInAgentTemplateLocale('pt')).toBe('pt-BR');
    expect(resolveBuiltInAgentTemplateLocale('en-GB')).toBe('en-US');
  });

  it('falls back to en-US when the locale is missing or unknown', () => {
    expect(resolveBuiltInAgentTemplateLocale()).toBe('en-US');
    expect(resolveBuiltInAgentTemplateLocale('  ')).toBe('en-US');
    expect(resolveBuiltInAgentTemplateLocale('zz-ZZ')).toBe('en-US');
  });
});

describe('builtInAgentTemplatesForImport', () => {
  it('loads 40 en-US examples from the suggestQuestions source without duplicating copy', () => {
    const rows = builtInAgentTemplatesForImport('en-US');
    expect(rows).toHaveLength(40);
    expect(rows[0]).toMatchObject({
      description: '',
      identifier: 'agent-01',
      title: EN_US_AGENT_01_TITLE,
    });
    expect(rows[0]?.systemRole.length).toBeGreaterThan(20);
    expect(rows[39]?.identifier).toBe('agent-40');
  });

  it('resolves ja-JP, zh-TW, zh, and unknown locales onto the matching catalog', () => {
    const en = builtInAgentTemplatesForImport('en-US');
    const ja = builtInAgentTemplatesForImport('ja-JP');
    const tw = builtInAgentTemplatesForImport('zh-TW');
    const zh = builtInAgentTemplatesForImport('zh');
    const cn = builtInAgentTemplatesForImport('zh-CN');
    const unknown = builtInAgentTemplatesForImport('zz-ZZ');

    expect(ja[0]?.title).toBe(JA_JP_AGENT_01_TITLE);
    expect(tw[0]?.title).toBe(ZH_TW_AGENT_01_TITLE);
    expect(zh[0]?.title).toBe(ZH_CN_AGENT_01_TITLE);
    expect(cn[0]?.title).toBe(ZH_CN_AGENT_01_TITLE);
    expect(unknown[0]?.title).toBe(EN_US_AGENT_01_TITLE);
    expect(unknown[0]?.title).toBe(en[0]?.title);
    expect(ja[0]?.title).not.toBe(en[0]?.title);
    expect(tw[0]?.title).not.toBe(cn[0]?.title);
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
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'ja-JP' }).rows).toHaveLength(40);
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'zh-TW' }).rows).toHaveLength(40);
  });

  it('uses the same locale resolution as preview for importBuiltins', () => {
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'ja-JP' }).rows[0]?.title).toBe(
      JA_JP_AGENT_01_TITLE,
    );
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'zh-TW' }).rows[0]?.title).toBe(
      ZH_TW_AGENT_01_TITLE,
    );
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'zh' }).rows[0]?.title).toBe(
      ZH_CN_AGENT_01_TITLE,
    );
    expect(fetchBuiltInAgentTemplatesForImport({ locale: 'zz-ZZ' }).rows[0]?.title).toBe(
      EN_US_AGENT_01_TITLE,
    );
  });
});
