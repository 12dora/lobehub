import { describe, expect, it } from 'vitest';

import { mergeReauthAuthorizationParams } from './reauthAuthorizationParams';

describe('mergeReauthAuthorizationParams', () => {
  it('adds prompt=login and max_age=0 when reauth flag is set', () => {
    expect(mergeReauthAuthorizationParams({ foo: 'bar' }, { reauth: true })).toEqual({
      foo: 'bar',
      max_age: '0',
      prompt: 'login',
    });
  });

  it('adds params when additionalData.prompt is login', () => {
    expect(mergeReauthAuthorizationParams({}, { prompt: 'login' })).toEqual({
      max_age: '0',
      prompt: 'login',
    });
  });

  it('leaves normal sign-in params unchanged', () => {
    expect(mergeReauthAuthorizationParams({ scope: 'openid' }, {})).toEqual({
      scope: 'openid',
    });
    expect(mergeReauthAuthorizationParams({ scope: 'openid' }, null)).toEqual({
      scope: 'openid',
    });
    expect(mergeReauthAuthorizationParams({ scope: 'openid' })).toEqual({
      scope: 'openid',
    });
  });
});
