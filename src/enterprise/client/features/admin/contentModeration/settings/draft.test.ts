import { describe, expect, it } from 'vitest';

import { MODERATION_LIMITS } from '@/const/platform/contentModeration';
import {
  type ContentModerationSettingsView,
  createDefaultContentModerationConfig,
} from '@/types/platform/contentModeration';

import {
  defaultCategoryPolicies,
  effectiveApiKeyCount,
  fingerprintDraft,
  fingerprintDraftBase,
  fingerprintKeywords,
  MODERATION_BLOCK_MESSAGE_MAX,
  MODERATION_DOWNGRADE_MESSAGE_MAX,
  MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES,
  parseKeywordImport,
  toDraft,
  toUpdateConfig,
  validateDraft,
  validateDraftBase,
  validateKeywordRules,
} from './draft';

const view = (patch: Partial<ContentModerationSettingsView> = {}): ContentModerationSettingsView =>
  ({
    ...createDefaultContentModerationConfig(),
    revision: 3,
    updatedAt: new Date('2026-08-17T00:00:00.000Z'),
    updatedBy: 'admin-1',
    ...patch,
  }) as ContentModerationSettingsView;

describe('toDraft / fingerprintDraft', () => {
  it('drops the revision metadata and starts with no pending keys', () => {
    const draft = toDraft(view());
    expect(draft.addedApiKeys).toEqual([]);
    expect(draft.config).not.toHaveProperty('revision');
    expect(draft.config).not.toHaveProperty('updatedAt');
    expect(draft.config.mode).toBe('off');
  });

  it('fingerprints structurally, so key order alone is not a change', () => {
    const left = toDraft(view());
    const right = toDraft(view());
    right.config.categories = Object.fromEntries(
      Object.entries(right.config.categories).reverse(),
    ) as typeof right.config.categories;
    expect(fingerprintDraft(left)).toBe(fingerprintDraft(right));

    right.config.mode = 'enforce';
    expect(fingerprintDraft(left)).not.toBe(fingerprintDraft(right));
  });
});

describe('toUpdateConfig', () => {
  it('turns masked keys into keep fingerprints and typed keys into add', () => {
    const draft = toDraft(
      view({
        classifier: {
          kind: 'moderations_api',
          moderationsApi: {
            apiKeys: [
              { fingerprint: 'fp-1', masked: 'sk-…ab12' },
              { fingerprint: 'fp-2', masked: 'sk-…cd34' },
            ],
            baseUrl: 'https://api.example.com',
            model: 'omni-moderation-latest',
          },
          onError: 'allow',
          retryCount: 1,
          timeoutMs: 3000,
        },
      } as Partial<ContentModerationSettingsView>),
    );
    draft.addedApiKeys = ['sk-plaintext', '  '];

    const update = toUpdateConfig(draft, { persistedBaseUrl: 'https://api.example.com' });
    expect(update.classifier.moderationsApi).toEqual({
      apiKeys: { add: ['sk-plaintext'], keep: ['fp-1', 'fp-2'] },
      baseUrl: 'https://api.example.com',
      model: 'omni-moderation-latest',
    });
  });

  it('omits the moderations sub-form entirely when the classifier does not use it', () => {
    const update = toUpdateConfig(toDraft(view()));
    expect(update.classifier.moderationsApi).toBeUndefined();
    expect(update.classifier.kind).toBe('none');
  });
});

describe('validateDraft', () => {
  it('accepts the shipped defaults', () => {
    expect(validateDraft(toDraft(view()))).toEqual([]);
  });

  it('rejects a regex rule that does not compile', () => {
    const draft = toDraft(view());
    draft.config.keywords = [
      {
        action: 'block',
        category: 'illicit',
        enabled: true,
        id: '00000000-0000-4000-8000-000000000000',
        isRegex: true,
        pattern: '([a-z',
      },
    ];
    expect(validateDraft(draft)).toContainEqual({
      key: 'keywordRegex',
      params: { pattern: '([a-z', row: 1 },
    });
  });

  it('does not flag the same pattern when it is a plain keyword', () => {
    const draft = toDraft(view());
    draft.config.keywords = [
      {
        action: 'block',
        category: 'illicit',
        enabled: true,
        id: '00000000-0000-4000-8000-000000000000',
        isRegex: false,
        pattern: '([a-z',
      },
    ];
    expect(validateDraft(draft)).toEqual([]);
  });

  it('caps the non-hit retention at the hard limit', () => {
    const draft = toDraft(view());
    draft.config.records.nonHitRetentionDays = MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS + 1;
    expect(validateDraft(draft)).toContainEqual({
      key: 'nonHitRetention',
      params: { max: MODERATION_LIMITS.NON_HIT_RETENTION_MAX_DAYS },
    });
  });

  it('requires a complete downgrade pair and a recipient for notifications', () => {
    const draft = toDraft(view());
    draft.config.downgrade = { model: '', provider: 'openai' };
    draft.config.notify = { emails: [], enabled: true, onActions: ['block'] };
    const issues = validateDraft(draft).map((issue) => issue.key);
    expect(issues).toContain('downgradeIncomplete');
    expect(issues).toContain('notifyEmailsRequired');
  });

  it('flags an invalid notification address', () => {
    const draft = toDraft(view());
    draft.config.notify = { emails: ['not-an-email'], enabled: true, onActions: ['block'] };
    expect(validateDraft(draft)).toContainEqual({
      key: 'notifyEmailInvalid',
      params: { email: 'not-an-email' },
    });
  });

  it('requires the sub-form of the selected classifier', () => {
    const draft = toDraft(view());
    draft.config.classifier = {
      kind: 'llm_judge',
      llmJudge: { model: '', provider: '' },
      onError: 'allow',
      retryCount: 1,
      timeoutMs: 3000,
    };
    expect(validateDraft(draft).map((issue) => issue.key)).toContain('llmJudgeRequired');
  });
});

describe('parseKeywordImport', () => {
  it('parses pattern, category and action, and defaults the rest', () => {
    const result = parseKeywordImport('foo\tviolence\tblock\nbare', []);
    expect(result.rules).toEqual([
      { action: 'block', category: 'violence', enabled: true, isRegex: false, pattern: 'foo' },
      { action: 'log', category: 'other', enabled: true, isRegex: false, pattern: 'bare' },
    ]);
    expect(result.invalidLines).toEqual([]);
    expect(result.skippedByCapacity).toBe(0);
  });

  it('drops duplicates case-insensitively, against existing rules and within the block', () => {
    const existing = [
      {
        action: 'log' as const,
        category: 'other' as const,
        enabled: true,
        id: '00000000-0000-4000-8000-000000000000',
        isRegex: false,
        pattern: 'Foo',
      },
    ];
    const result = parseKeywordImport('foo\nFOO\nbar', existing);
    expect(result.rules.map((rule) => rule.pattern)).toEqual(['bar']);
    expect(result.skippedDuplicates).toBe(2);
  });

  it('reports lines with an unknown category or action', () => {
    const result = parseKeywordImport('a\tnope\nb\tviolence\tnope', []);
    expect(result.invalidLines).toEqual([1, 2]);
    expect(result.rules).toEqual([]);
  });
});

describe('defaultCategoryPolicies', () => {
  it('returns a fresh copy so restoring defaults cannot alias the shared constant', () => {
    const first = defaultCategoryPolicies();
    first.sexual.threshold = 0.01;
    expect(defaultCategoryPolicies().sexual.threshold).not.toBe(0.01);
  });
});

describe('parseKeywordImport capacity', () => {
  it('truncates to the remaining room and reports what the ceiling refused', () => {
    const result = parseKeywordImport('a\nb\nc', [], { capacity: 1 });
    expect(result.rules.map((rule) => rule.pattern)).toEqual(['a']);
    expect(result.skippedByCapacity).toBe(2);
  });

  it('reports nothing importable when there is no room at all', () => {
    const result = parseKeywordImport('a\nb', [], { capacity: 0 });
    expect(result.rules).toEqual([]);
    expect(result.skippedByCapacity).toBe(2);
  });
});

describe('toUpdateConfig endpoint change', () => {
  const withKeys = (baseUrl: string) =>
    toDraft(
      view({
        classifier: {
          kind: 'moderations_api',
          moderationsApi: {
            apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
            baseUrl,
            model: 'omni-moderation-latest',
          },
          onError: 'allow',
          retryCount: 1,
          timeoutMs: 3000,
        },
      } as Partial<ContentModerationSettingsView>),
    );

  it('keeps stored keys while the endpoint is unchanged (ignoring a trailing slash)', () => {
    const update = toUpdateConfig(withKeys('https://api.example.com/'), {
      persistedBaseUrl: 'https://api.example.com',
    });
    expect(update.classifier.moderationsApi?.apiKeys.keep).toEqual(['fp-1']);
  });

  it('drops stored keys from keep once the endpoint moved — the server would reject them', () => {
    const update = toUpdateConfig(withKeys('https://other.example.com'), {
      persistedBaseUrl: 'https://api.example.com',
    });
    expect(update.classifier.moderationsApi?.apiKeys.keep).toEqual([]);
  });

  it('drops stored keys when there is no persisted endpoint to compare against', () => {
    const update = toUpdateConfig(withKeys('https://api.example.com'), {});
    expect(update.classifier.moderationsApi?.apiKeys.keep).toEqual([]);
  });
});

describe('fingerprint split', () => {
  it('changes the keyword half only when the rules change', () => {
    const draft = toDraft(view());
    const base = fingerprintDraftBase(draft);
    const keywords = fingerprintKeywords(draft.config.keywords);

    draft.config.mode = 'observe';
    expect(fingerprintDraftBase(draft)).not.toBe(base);
    expect(fingerprintKeywords(draft.config.keywords)).toBe(keywords);
  });

  it('excludes the keyword rules from the base half', () => {
    const draft = toDraft(view());
    const base = fingerprintDraftBase(draft);
    draft.config.keywords = [
      {
        action: 'log',
        category: 'other',
        enabled: true,
        id: '00000000-0000-4000-8000-000000000000',
        isRegex: false,
        pattern: 'x',
      },
    ];
    expect(fingerprintDraftBase(draft)).toBe(base);
    expect(fingerprintKeywords(draft.config.keywords)).not.toBe(fingerprintKeywords([]));
  });
});

describe('validateKeywordRules', () => {
  it('scales to the 10,000-rule ceiling without re-compiling every regex', () => {
    const rules = Array.from({ length: 10_000 }, (_, index) => ({
      action: 'log' as const,
      category: 'other' as const,
      enabled: true,
      id: `rule-${index}`,
      isRegex: true,
      pattern: `term-${index % 500}`,
    }));
    const started = Date.now();
    for (let pass = 0; pass < 5; pass += 1) {
      expect(validateKeywordRules(rules)).toEqual([]);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

const moderationsDraft = (baseUrl: string, added: string[] = []) => {
  const draft = toDraft(
    view({
      classifier: {
        kind: 'moderations_api',
        moderationsApi: {
          apiKeys: [{ fingerprint: 'fp-1', masked: 'sk-…ab12' }],
          baseUrl,
          model: 'omni-moderation-latest',
        },
        onError: 'allow',
        retryCount: 1,
        timeoutMs: 3000,
      },
    } as Partial<ContentModerationSettingsView>),
  );
  draft.addedApiKeys = added;
  return draft;
};

describe('effectiveApiKeyCount', () => {
  it('counts a retained key while the endpoint is unchanged', () => {
    expect(
      effectiveApiKeyCount(moderationsDraft('https://api.example.com/'), 'https://api.example.com'),
    ).toBe(1);
  });

  it('counts zero once the endpoint moved — those keys are dropped on the wire', () => {
    expect(
      effectiveApiKeyCount(
        moderationsDraft('https://moved.example.com'),
        'https://api.example.com',
      ),
    ).toBe(0);
  });

  it('counts replacement keys typed in this session, ignoring blank rows', () => {
    expect(
      effectiveApiKeyCount(
        moderationsDraft('https://moved.example.com', ['sk-new', '   ']),
        'https://api.example.com',
      ),
    ).toBe(1);
  });
});

describe('validateDraftBase — effective keys', () => {
  it('accepts a moderations classifier whose stored key survives', () => {
    const issues = validateDraftBase(moderationsDraft('https://api.example.com'), {
      persistedBaseUrl: 'https://api.example.com',
    });
    expect(issues.map((issue) => issue.key)).not.toContain('moderationsApiKeyRequired');
  });

  it('refuses to save a classifier that would end up with no key at all', () => {
    const issues = validateDraftBase(moderationsDraft('https://moved.example.com'), {
      persistedBaseUrl: 'https://api.example.com',
    });
    expect(issues.map((issue) => issue.key)).toContain('moderationsApiKeyRequired');
  });

  it('clears once a replacement key is entered', () => {
    const issues = validateDraftBase(moderationsDraft('https://moved.example.com', ['sk-new']), {
      persistedBaseUrl: 'https://api.example.com',
    });
    expect(issues.map((issue) => issue.key)).not.toContain('moderationsApiKeyRequired');
  });

  it('is consistent with what toUpdateConfig actually sends', () => {
    const draft = moderationsDraft('https://moved.example.com');
    const update = toUpdateConfig(draft, { persistedBaseUrl: 'https://api.example.com' });
    const sentKeys =
      update.classifier.moderationsApi!.apiKeys.keep.length +
      update.classifier.moderationsApi!.apiKeys.add.length;
    expect(sentKeys).toBe(effectiveApiKeyCount(draft, 'https://api.example.com'));
  });
});

describe('message length contracts', () => {
  it('accepts messages at the limits', () => {
    const draft = toDraft(view());
    draft.config.messages.blockMessage = 'a'.repeat(MODERATION_BLOCK_MESSAGE_MAX);
    draft.config.messages.downgradeMessage = 'a'.repeat(MODERATION_DOWNGRADE_MESSAGE_MAX);
    expect(validateDraft(draft)).toEqual([]);
  });

  it('rejects an over-long block message', () => {
    const draft = toDraft(view());
    draft.config.messages.blockMessage = 'a'.repeat(MODERATION_BLOCK_MESSAGE_MAX + 1);
    expect(validateDraft(draft)).toContainEqual({
      key: 'blockMessageTooLong',
      params: { max: MODERATION_BLOCK_MESSAGE_MAX },
    });
  });

  it('caps the downgrade notice far below the block message — it rides on a response header', () => {
    expect(MODERATION_DOWNGRADE_MESSAGE_MAX).toBeLessThan(MODERATION_BLOCK_MESSAGE_MAX);
    const draft = toDraft(view());
    draft.config.messages.downgradeMessage = 'a'.repeat(MODERATION_DOWNGRADE_MESSAGE_MAX + 1);
    expect(validateDraft(draft)).toContainEqual({
      key: 'downgradeMessageTooLong',
      params: { max: MODERATION_DOWNGRADE_MESSAGE_MAX },
    });
  });

  it('rejects a CJK notice that is within the character cap but too heavy once encoded', () => {
    const draft = toDraft(view());
    // 300 CJK characters percent-encode to ~2,700 bytes — inside the char cap, past the byte cap.
    draft.config.messages.downgradeMessage = '审'.repeat(MODERATION_DOWNGRADE_MESSAGE_MAX);
    expect(encodeURIComponent(draft.config.messages.downgradeMessage).length).toBeGreaterThan(
      MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES,
    );
    expect(validateDraft(draft)).toContainEqual({
      key: 'downgradeMessageTooHeavy',
      params: { max: MODERATION_DOWNGRADE_MESSAGE_MAX_ENCODED_BYTES },
    });
  });

  it('accepts a shorter CJK notice', () => {
    const draft = toDraft(view());
    draft.config.messages.downgradeMessage = '该消息因内容审计已改用 {{model}} 回复';
    expect(validateDraft(draft)).toEqual([]);
  });
});
