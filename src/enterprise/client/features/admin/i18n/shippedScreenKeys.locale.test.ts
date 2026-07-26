import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Literal `t()` keys that previously only had English `defaultValue` fallbacks
 * (XC-I18N-003 / CS-02). Assert catalogs own them so zh-CN cannot silently
 * degrade to English.
 */
const ADMIN_KEYS = [
  'generalSettings.conflict',
  'generalSettings.conflict.description',
  'generalSettings.conflict.title',
  'identityProviders.delete.cancel',
  'identityProviders.delete.impact',
  'identityProviders.delete.confirm',
  'identityProviders.delete.title',
  'identityProviders.delete.success',
  'identityProviders.actions.delete',
] as const;

const CHAT_KEYS = [
  'heteroAgent.cloudCredLoading.desc',
  'heteroAgent.cloudCredLoading.title',
  'heteroAgent.cloudCredError.retry',
  'heteroAgent.cloudCredError.desc',
  'heteroAgent.cloudCredError.title',
] as const;

const MODEL_PROVIDER_KEYS = ['providerModels.config.apiKey.configuredPlaceholder'] as const;

const SETTING_MANAGED_RESOURCE_KEYS = [
  'managedResources.resource.agents',
  'managedResources.resource.aiModels',
  'managedResources.resource.aiProviders',
  'managedResources.resource.connectors',
  'managedResources.resource.skills',
] as const;

const ACCEPTED_TECHNICAL_VALUES = ['JSON', 'MCP', 'OAuth', 'URL'] as const;

const loadLocale = (locale: 'en-US' | 'zh-CN', ns: string): Record<string, string> => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const filePath = path.join(here, '../../../../../../locales', locale, `${ns}.json`);
  return JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, string>;
};

const assertKeys = (
  locale: 'en-US' | 'zh-CN',
  ns: string,
  keys: readonly string[],
  /** Exact technical-token values intentionally shared by both locales. */
  allowEnglish: readonly string[] = ACCEPTED_TECHNICAL_VALUES,
) => {
  const data = loadLocale(locale, ns);
  const english = locale === 'zh-CN' ? loadLocale('en-US', ns) : undefined;
  const missing: string[] = [];
  const bad: string[] = [];
  for (const key of keys) {
    const value = data[key];
    if (!value?.trim()) {
      missing.push(`${locale}/${ns}:${key}`);
      continue;
    }
    if (locale === 'zh-CN' && english?.[key] === value && !allowEnglish.includes(value)) {
      bad.push(`${locale}/${ns}:${key} still English (${value})`);
    }
  }
  expect(missing, `missing keys:\n${missing.join('\n')}`).toEqual([]);
  expect(bad, `untranslated keys:\n${bad.join('\n')}`).toEqual([]);
};

describe('shipped screen locale keys (XC-I18N-003 / CS-02 / XC-I18N-004)', () => {
  it('admin conflict + identity-provider delete keys exist in en-US and zh-CN', () => {
    assertKeys('en-US', 'admin', ADMIN_KEYS);
    assertKeys('zh-CN', 'admin', ADMIN_KEYS);
  });

  it('chat heteroAgent cloud credential keys exist in en-US and zh-CN', () => {
    assertKeys('en-US', 'chat', CHAT_KEYS);
    assertKeys('zh-CN', 'chat', CHAT_KEYS);
  });

  it('modelProvider configured API-key placeholder exists in en-US and zh-CN', () => {
    assertKeys('en-US', 'modelProvider', MODEL_PROVIDER_KEYS);
    assertKeys('zh-CN', 'modelProvider', MODEL_PROVIDER_KEYS);
  });

  it('setting managed resource names are translated in zh-CN', () => {
    assertKeys('en-US', 'setting', SETTING_MANAGED_RESOURCE_KEYS);
    assertKeys('zh-CN', 'setting', SETTING_MANAGED_RESOURCE_KEYS);
  });

  it('keeps every shipped Connector catalog string translated in zh-CN', () => {
    const english = loadLocale('en-US', 'admin');
    const chinese = loadLocale('zh-CN', 'admin');
    const connectorKeys = Object.keys(english).filter((key) => key.startsWith('connectorCatalog.'));
    assertKeys('en-US', 'admin', connectorKeys);
    assertKeys('zh-CN', 'admin', connectorKeys);

    const ordinaryEnglish = /\b(?:Connector|Revision|Secret|Scope|Deny|Token|Tool)\b/i;
    const mixedEnglish = connectorKeys
      .filter((key) => {
        const withoutInterpolation = chinese[key].replaceAll(/\{\{[^}]+\}\}/g, '');
        return ordinaryEnglish.test(withoutInterpolation);
      })
      .map((key) => `${key}: ${chinese[key]}`);
    expect(mixedEnglish, `mixed-English connector copy:\n${mixedEnglish.join('\n')}`).toEqual([]);

    expect(chinese).toMatchObject({
      'connectorCatalog.actions.create': '创建连接器',
      'connectorCatalog.conflict.title': '连接器版本冲突',
      'connectorCatalog.create.title': '创建连接器草稿',
      'connectorCatalog.editor.oauthClientSecret': '替换 OAuth 客户端密钥',
      'connectorCatalog.editor.scopes': 'OAuth 权限范围（以空格分隔）',
      'connectorCatalog.list.columns.revision': '草稿版本',
      'connectorCatalog.list.title': '平台连接器',
      'connectorCatalog.tools.description':
        '平台拒绝规则始终优先。风险等级和确认要求会包含在已发布版本中。',
      'connectorCatalog.unsaved.description': '存在未保存的连接器公开配置；密钥不会写入恢复草稿。',
    });
  });
});
