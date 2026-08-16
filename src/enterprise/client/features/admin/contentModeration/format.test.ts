import { describe, expect, it } from 'vitest';

import { MODERATION_CATEGORIES } from '@/const/platform/contentModeration';

import {
  buildCategoryRows,
  classifierHealthLevel,
  EFFECTIVE_ACTION_TAG_COLOR,
  formatLatency,
  formatModelPair,
  formatPercent,
  formatScore,
  sortCategoriesByScore,
} from './format';

describe('classifierHealthLevel', () => {
  it('never claims healthy without samples', () => {
    expect(classifierHealthLevel('llm_judge', null)).toBe('unknown');
    expect(classifierHealthLevel('llm_judge', { sampleSize: 0, successRate: 1 })).toBe('unknown');
  });

  it('reports disabled before anything else', () => {
    expect(classifierHealthLevel('none', { sampleSize: 100, successRate: 0 })).toBe('disabled');
  });

  it('splits healthy / unstable / failing on the success rate', () => {
    expect(classifierHealthLevel('llm_judge', { sampleSize: 100, successRate: 0.99 })).toBe(
      'healthy',
    );
    expect(classifierHealthLevel('llm_judge', { sampleSize: 100, successRate: 0.85 })).toBe(
      'unstable',
    );
    expect(classifierHealthLevel('llm_judge', { sampleSize: 100, successRate: 0.5 })).toBe('error');
  });
});

describe('formatters', () => {
  it('formats scores, latency, percentages and model pairs', () => {
    expect(formatScore(0.8213)).toBe('0.82');
    expect(formatScore(null)).toBe('—');
    expect(formatLatency(240)).toBe('240 ms');
    expect(formatLatency(2400)).toBe('2.4 s');
    expect(formatLatency(null)).toBe('—');
    expect(formatPercent(0.955)).toBe('96%');
    expect(formatModelPair('openai', 'gpt-4o')).toBe('openai / gpt-4o');
    expect(formatModelPair(null, null)).toBe('—');
  });

  it('keeps allow neutral and colours every other outcome', () => {
    expect(EFFECTIVE_ACTION_TAG_COLOR.allow).toBeUndefined();
    expect(EFFECTIVE_ACTION_TAG_COLOR.block).toBe('red');
    expect(EFFECTIVE_ACTION_TAG_COLOR.downgrade).toBe('orange');
    expect(EFFECTIVE_ACTION_TAG_COLOR.log).toBe('gold');
    expect(EFFECTIVE_ACTION_TAG_COLOR.error).toBe('volcano');
  });
});

describe('buildCategoryRows', () => {
  it('emits one row per platform category, even without a score', () => {
    const rows = buildCategoryRows(MODERATION_CATEGORIES, { sexual: 0.9 }, undefined);
    expect(rows).toHaveLength(MODERATION_CATEGORIES.length);
    expect(rows.find((row) => row.category === 'sexual')?.score).toBe(0.9);
    expect(rows.find((row) => row.category === 'violence')?.score).toBe(0);
  });

  it('marks a hit against the snapshot threshold, not the current policy', () => {
    const rows = buildCategoryRows(
      ['sexual', 'violence'],
      { sexual: 0.7, violence: 0.2 },
      { sexual: { action: 'block', threshold: 0.65 }, violence: { action: 'log', threshold: 0.9 } },
    );
    expect(rows.find((row) => row.category === 'sexual')?.hit).toBe(true);
    expect(rows.find((row) => row.category === 'violence')?.hit).toBe(false);
  });

  it('sorts by score so the reason for the decision reads first', () => {
    const sorted = sortCategoriesByScore([{ score: 0.1 }, { score: 0.9 }, { score: 0.5 }]);
    expect(sorted.map((row) => row.score)).toEqual([0.9, 0.5, 0.1]);
  });
});
