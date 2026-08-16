import { describe, expect, it } from 'vitest';

import { ClassifierInvalidResponseError, toClassifierErrorCode } from './types';

describe('toClassifierErrorCode', () => {
  it('maps each known failure onto a finite code', () => {
    expect(toClassifierErrorCode(Object.assign(new Error('Aborted'), { name: 'AbortError' }))).toBe(
      'aborted',
    );
    expect(toClassifierErrorCode(Object.assign(new Error('slow'), { name: 'TimeoutError' }))).toBe(
      'timeout',
    );
    expect(toClassifierErrorCode(new Error('request timeout'))).toBe('timeout');
    expect(toClassifierErrorCode(new Error('MODERATIONS_API_401'))).toBe('unauthorized');
    expect(toClassifierErrorCode(new Error('MODERATIONS_API_403'))).toBe('unauthorized');
    expect(toClassifierErrorCode(new Error('MODERATIONS_API_429'))).toBe('rate_limited');
    expect(toClassifierErrorCode(new Error('MODERATIONS_API_ALL_KEYS_FROZEN'))).toBe(
      'rate_limited',
    );
    expect(toClassifierErrorCode(new Error('MODERATIONS_API_500'))).toBe('upstream_error');
    expect(toClassifierErrorCode(new ClassifierInvalidResponseError())).toBe('invalid_response');
    expect(toClassifierErrorCode(new Error('MODERATIONS_API_400'))).toBe('invalid_response');
    expect(toClassifierErrorCode(new Error('CLASSIFIER_NOT_CONFIGURED'))).toBe('not_configured');
    expect(toClassifierErrorCode(new Error('LLM_JUDGE_MODEL_NOT_PUBLISHED'))).toBe(
      'not_configured',
    );
    expect(toClassifierErrorCode(new Error('MODERATIONS_API_NO_KEYS'))).toBe('not_configured');
  });

  it('never returns the raw exception message', () => {
    const leaked = 'upstream sk-abc leaked prompt: hello world';
    const code = toClassifierErrorCode(new Error(leaked));
    expect(code).toBe('upstream_error');
    expect(code).not.toContain('sk-abc');
    expect(code).not.toContain('hello world');
  });
});
