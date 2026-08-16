import { describe, expect, it } from 'vitest';

import { MODERATION_DEFAULT_CATEGORY_POLICY } from '@/const/platform/contentModeration';
import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import {
  computePolicyAction,
  isExempt,
  isModelInScope,
  isSampled,
  mapOpenAiCategoryScores,
} from './policy';

describe('computePolicyAction', () => {
  it('uses default category policy: sexual_minors block, other ignore', () => {
    const highMinors = computePolicyAction({
      categories: MODERATION_DEFAULT_CATEGORY_POLICY,
      scores: { sexual_minors: 0.6 },
    });
    expect(highMinors.policyAction).toBe('block');
    expect(highMinors.triggered).toContain('sexual_minors');

    const other = computePolicyAction({
      categories: MODERATION_DEFAULT_CATEGORY_POLICY,
      scores: { other: 0.5 },
    });
    expect(other.policyAction).toBe('ignore');
  });

  it('takes the stricter of rule action and category action on a keyword hit', () => {
    const result = computePolicyAction({
      categories: MODERATION_DEFAULT_CATEGORY_POLICY,
      matchedRule: {
        action: 'log',
        category: 'sexual',
        enabled: true,
        id: '11111111-1111-4111-8111-111111111111',
        isRegex: false,
        pattern: 'x',
      },
      scores: { sexual: 1 },
    });
    // default sexual action is block, which is stricter than the rule's log
    expect(result.policyAction).toBe('block');
  });
});

describe('mapOpenAiCategoryScores', () => {
  it('maps OpenAI 13 classes onto the 10 platform categories taking the max', () => {
    const scores = mapOpenAiCategoryScores({
      'harassment': 0.2,
      'hate/threatening': 0.8,
      'self-harm': 0.1,
      'self-harm/intent': 0.4,
      'sexual': 0.3,
      'sexual/minors': 0.7,
    });
    expect(scores.hate_harassment).toBe(0.8);
    expect(scores.self_harm).toBe(0.4);
    expect(scores.sexual).toBe(0.3);
    expect(scores.sexual_minors).toBe(0.7);
    expect(scores.political).toBe(0);
  });
});

describe('isSampled', () => {
  it('is deterministic for a given hash and rate', () => {
    const hash = '0000006400000000'; // 0x64 = 100, 100 % 100 = 0
    expect(isSampled(hash, 0)).toBe(false);
    expect(isSampled(hash, 100)).toBe(true);
    expect(isSampled(hash, 1)).toBe(true);
    expect(isSampled('ffffffff', 50)).toBe(isSampled('ffffffff', 50));
  });
});

describe('isExempt / isModelInScope', () => {
  it('exempts configured roles and user ids', () => {
    const config = createDefaultContentModerationConfig();
    config.scope.exemptUserIds = ['u-1'];
    expect(isExempt({ config, roles: ['member'], userId: 'u-1' })).toBe(true);
    expect(isExempt({ config, roles: ['admin'], userId: 'u-2' })).toBe(true);
    expect(isExempt({ config, roles: ['member'], userId: 'u-2' })).toBe(false);
  });

  it('applies include / exclude model filters keyed as provider/model', () => {
    const config = createDefaultContentModerationConfig();
    config.scope.modelFilter = { models: ['openai/gpt-4o'], type: 'include' };
    expect(isModelInScope({ config, model: 'gpt-4o', provider: 'openai' })).toBe(true);
    expect(isModelInScope({ config, model: 'other', provider: 'openai' })).toBe(false);

    config.scope.modelFilter = { models: ['openai/gpt-4o'], type: 'exclude' };
    expect(isModelInScope({ config, model: 'gpt-4o', provider: 'openai' })).toBe(false);
    expect(isModelInScope({ config, model: 'other', provider: 'openai' })).toBe(true);
  });
});
