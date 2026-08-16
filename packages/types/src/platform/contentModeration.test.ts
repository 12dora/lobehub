import { describe, expect, it } from 'vitest';

import type { KeywordRule } from './contentModeration';
import {
  contentModerationConfigSchema,
  createDefaultContentModerationConfig,
  keywordRuleSchema,
} from './contentModeration';

const validKeyword = (overrides: Partial<KeywordRule> = {}): KeywordRule => ({
  action: 'block',
  category: 'sexual',
  enabled: true,
  id: '11111111-1111-4111-8111-111111111111',
  isRegex: false,
  pattern: 'badword',
  ...overrides,
});

describe('createDefaultContentModerationConfig', () => {
  it('returns a config that satisfies the persisted schema', () => {
    const defaults = createDefaultContentModerationConfig();
    const parsed = contentModerationConfigSchema.parse(defaults);
    expect(parsed.mode).toBe('off');
    expect(parsed.scope.exemptRoles).toEqual(['super_admin', 'admin']);
    expect(parsed.classifier.kind).toBe('none');
    expect(parsed.downgrade).toBeNull();
    expect(parsed.records.nonHitRetentionDays).toBe(3);
    expect(parsed.autoBan.enabled).toBe(false);
    expect(parsed.messages.blockMessage).toBe('');
    expect(parsed.messages.downgradeMessage).toBe('');
  });

  it('deep-clones category defaults so callers cannot mutate later factories', () => {
    const first = createDefaultContentModerationConfig();
    first.categories.sexual.threshold = 0.11;
    const second = createDefaultContentModerationConfig();
    expect(second.categories.sexual.threshold).toBe(0.65);
  });
});

describe('contentModerationConfigSchema', () => {
  it('reports the offending keyword index when a regex does not compile', () => {
    const config = createDefaultContentModerationConfig();
    config.keywords = [
      validKeyword({ id: '11111111-1111-4111-8111-111111111111', pattern: 'ok' }),
      validKeyword({
        id: '22222222-2222-4222-8222-222222222222',
        isRegex: true,
        pattern: '(unclosed',
      }),
    ];

    const result = contentModerationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((item) =>
      item.message.includes('INVALID_KEYWORD_REGEX'),
    );
    expect(issue).toBeDefined();
    expect(issue?.path).toEqual(['keywords', 1, 'pattern']);
    expect(issue?.message).toContain('keywords[1]');
  });

  it('rejects nonHitRetentionDays greater than 3', () => {
    const config = createDefaultContentModerationConfig();
    config.records.nonHitRetentionDays = 4;

    const result = contentModerationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (issue) =>
          issue.path.join('.') === 'records.nonHitRetentionDays' ||
          issue.message === 'NON_HIT_RETENTION_TOO_LONG',
      ),
    ).toBe(true);
  });

  it('rejects thresholds outside 0..1', () => {
    const config = createDefaultContentModerationConfig();
    config.categories.sexual.threshold = 1.2;
    expect(contentModerationConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects invalid notify emails and more than 20 addresses', () => {
    const config = createDefaultContentModerationConfig();
    config.notify.emails = ['not-an-email'];
    expect(contentModerationConfigSchema.safeParse(config).success).toBe(false);

    const tooMany = createDefaultContentModerationConfig();
    tooMany.notify.emails = Array.from({ length: 21 }, (_, i) => `user${i}@example.com`);
    expect(contentModerationConfigSchema.safeParse(tooMany).success).toBe(false);
  });

  it('rejects unknown keys via .strict()', () => {
    const result = contentModerationConfigSchema.safeParse({
      ...createDefaultContentModerationConfig(),
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects catastrophic nested-quantifier regexes with the rule index', () => {
    const config = createDefaultContentModerationConfig();
    config.keywords = [
      validKeyword({ isRegex: true, pattern: 'ok' }),
      validKeyword({
        id: '22222222-2222-4222-8222-222222222222',
        isRegex: true,
        pattern: '(a+)+$',
      }),
    ];
    const result = contentModerationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((item) => item.message.includes('UNSAFE_KEYWORD_REGEX'));
    expect(issue?.path).toEqual(['keywords', 1, 'pattern']);
    expect(issue?.message).toContain('unsafe_quantified_group');
  });

  it('rejects (\\w*)*x and accepts a safe regex', () => {
    const unsafe = createDefaultContentModerationConfig();
    unsafe.keywords = [validKeyword({ isRegex: true, pattern: '(\\w*)*x' })];
    expect(contentModerationConfigSchema.safeParse(unsafe).success).toBe(false);

    const safe = createDefaultContentModerationConfig();
    safe.keywords = [validKeyword({ isRegex: true, pattern: 'caf[eé]' })];
    expect(contentModerationConfigSchema.safeParse(safe).success).toBe(true);
  });

  it('rejects the conservative ReDoS examples at save time and accepts two unbounded wildcards', () => {
    const rejected = [
      '(a|a)*',
      '(.*a){20}',
      '(\\w+\\s?)+',
      '\\d+\\d+\\d+$',
      'a{0,201}',
      '((a|a)*)',
      '((.*a){20})',
      '((\\w+\\s?)+)',
      '(\\d+\\d+\\d+$)',
      '(a{0,201})',
    ];
    for (const pattern of rejected) {
      const config = createDefaultContentModerationConfig();
      config.keywords = [validKeyword({ isRegex: true, pattern })];
      expect(contentModerationConfigSchema.safeParse(config).success).toBe(false);
    }

    const allowed = createDefaultContentModerationConfig();
    allowed.keywords = [validKeyword({ isRegex: true, pattern: 'foo.*bar.*baz' })];
    expect(contentModerationConfigSchema.safeParse(allowed).success).toBe(true);
  });

  it('rejects a downgradeMessage whose encodeURIComponent length exceeds 2048', () => {
    const config = createDefaultContentModerationConfig();
    config.messages.downgradeMessage = '审'.repeat(300);
    expect(encodeURIComponent(config.messages.downgradeMessage).length).toBeGreaterThan(2048);
    const result = contentModerationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (issue) =>
          issue.message === 'DOWNGRADE_MESSAGE_ENCODED_TOO_LONG' &&
          issue.path.join('.') === 'messages.downgradeMessage',
      ),
    ).toBe(true);

    const ascii = createDefaultContentModerationConfig();
    ascii.messages.downgradeMessage = 'Switched to a safer model';
    expect(contentModerationConfigSchema.safeParse(ascii).success).toBe(true);
  });

  it('requires llmJudge when classifier.kind is llm_judge', () => {
    const config = createDefaultContentModerationConfig();
    config.classifier.kind = 'llm_judge';
    const result = contentModerationConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.message === 'LLM_JUDGE_REQUIRED')).toBe(true);
  });
});

describe('keywordRuleSchema', () => {
  it('rejects a pattern longer than the keyword limit', () => {
    const result = keywordRuleSchema.safeParse(validKeyword({ pattern: 'x'.repeat(201) }));
    expect(result.success).toBe(false);
  });
});
