import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_ACTIONS,
  MODERATION_CLASSIFIER_KINDS,
  MODERATION_DECISION_SOURCES,
  MODERATION_EFFECTIVE_ACTIONS,
  MODERATION_MODES,
  MODERATION_REQUEST_KINDS,
} from '@/const/platform/contentModeration';
import { CONTENT_MODERATION_OVERVIEW_WARNINGS } from '@/types/platform/contentModeration';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

const load = (locale: 'en-US' | 'zh-CN', namespace: string): Record<string, string> =>
  JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'locales', locale, `${namespace}.json`), 'utf8'),
  ) as Record<string, string>;

/**
 * Every enum the server can emit has to be nameable in both shipped locales — a missing
 * label would surface a raw `sexual_minors` token to an operator.
 */
describe('content moderation locale catalog', () => {
  const en = load('en-US', 'admin');
  const zh = load('zh-CN', 'admin');
  const commonEn = load('en-US', 'common');
  const commonZh = load('zh-CN', 'common');

  const expectPresent = (bundle: Record<string, string>, key: string, label: string) => {
    expect(bundle[key]?.trim(), `${label} missing: ${key}`).toBeTruthy();
  };

  it('names every category in the shared `common` namespace', () => {
    for (const category of MODERATION_CATEGORIES) {
      expectPresent(commonEn, `moderation.category.${category}`, 'en');
      expectPresent(commonZh, `moderation.category.${category}`, 'zh');
      expectPresent(en, `contentModeration.categoryHint.${category}`, 'en');
      expectPresent(zh, `contentModeration.categoryHint.${category}`, 'zh');
    }
  });

  it('names every action, source, request kind, mode and classifier kind', () => {
    const keys = [
      ...MODERATION_EFFECTIVE_ACTIONS.map((value) => `contentModeration.action.${value}`),
      ...MODERATION_CATEGORY_ACTIONS.map((value) => `contentModeration.policyAction.${value}`),
      ...MODERATION_DECISION_SOURCES.map((value) => `contentModeration.source.${value}`),
      ...MODERATION_REQUEST_KINDS.map((value) => `contentModeration.requestKind.${value}`),
      ...MODERATION_MODES.flatMap((value) => [
        `contentModeration.mode.${value}`,
        `contentModeration.mode.${value}Desc`,
      ]),
      ...MODERATION_CLASSIFIER_KINDS.map((value) => `contentModeration.classifierKind.${value}`),
    ];
    for (const key of keys) {
      expectPresent(en, key, 'en');
      expectPresent(zh, key, 'zh');
    }
  });

  it('explains every overview warning the server can raise', () => {
    for (const warning of CONTENT_MODERATION_OVERVIEW_WARNINGS) {
      for (const suffix of ['title', 'desc']) {
        expectPresent(en, `contentModeration.warning.${warning}.${suffix}`, 'en');
        expectPresent(zh, `contentModeration.warning.${warning}.${suffix}`, 'zh');
      }
    }
  });

  it('names every server field path and rejection reason the UI maps', () => {
    // Mirrors FIELD_MESSAGE_KEY / REASON_MESSAGE_KEY in configErrors.ts.
    const keys = [
      ...[
        'llmJudge',
        'apiKeys',
        'apiKeysKeep',
        'baseUrl',
        'downgrade',
        'timezone',
        'range',
        'keywords',
      ].map((name) => `contentModeration.errors.field.${name}`),
      ...[
        'endpointChanged',
        'apiKeyMissing',
        'tooManyApiKeys',
        'modelNotPublished',
        'rangeInverted',
        'rangeTooLong',
        'unknownTimezone',
        'regexUnsafe',
        'regexSlow',
        'tooManyRegexChanges',
      ].map((name) => `contentModeration.errors.reason.${name}`),
    ];
    for (const key of keys) {
      expectPresent(en, key, 'en');
      expectPresent(zh, key, 'zh');
    }
  });

  it('names the keyword pagination and endpoint-change copy', () => {
    const keys = [
      'contentModeration.settings.keywords.search',
      'contentModeration.settings.keywords.searchPlaceholder',
      'contentModeration.settings.keywords.searchEmpty',
      'contentModeration.settings.keywords.pageInfo',
      'contentModeration.settings.keywords.pageSize',
      'contentModeration.settings.keywords.pageSizeOption',
      'contentModeration.settings.keywords.prevPage',
      'contentModeration.settings.keywords.nextPage',
      'contentModeration.settings.keywords.importedPartial',
      'contentModeration.settings.keywords.importFull',
      'contentModeration.settings.classifier.endpointChanged',
      'contentModeration.settings.classifier.keyWillBeRemoved',
      'contentModeration.settings.classifier.testStale',
      'contentModeration.records.userDeleted',
      'contentModeration.settings.basic.charCount',
      'contentModeration.errors.blockMessageTooLong',
      'contentModeration.errors.downgradeMessageTooLong',
      'contentModeration.errors.downgradeMessageTooHeavy',
      'contentModeration.settings.keywordsValidating',
    ];
    for (const key of keys) {
      expectPresent(en, key, 'en');
      expectPresent(zh, key, 'zh');
    }
  });

  it('does not promise user search in the toolbar copy — the server search is id + excerpt', () => {
    expect(zh['contentModeration.records.searchPlaceholder']).toBe('搜索请求 ID / 摘要');
    expect(en['contentModeration.records.searchPlaceholder']).not.toMatch(/user/i);
  });

  it('numbers the row-scoped regex rejections for humans', () => {
    // The mapper passes a 1-based `n`; the copy has to actually use it.
    for (const key of [
      'contentModeration.errors.reason.regexUnsafe',
      'contentModeration.errors.reason.regexSlow',
    ]) {
      expect(en[key]).toContain('{{n}}');
      expect(zh[key]).toContain('{{n}}');
    }
    // The batch-limit message names no row, so it must NOT carry the placeholder.
    expect(zh['contentModeration.errors.reason.tooManyRegexChanges']).not.toContain('{{n}}');
  });

  it('has a nav label in both locales', () => {
    expectPresent(en, 'nav.contentModeration', 'en');
    expectPresent(zh, 'nav.contentModeration', 'zh');
    expect(zh['nav.contentModeration']).toBe('内容审计');
  });
});
