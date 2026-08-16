import { describe, expect, it } from 'vitest';

import { maskModerationApiKey } from './secrets';

describe('maskModerationApiKey', () => {
  it('fully masks keys of 8 characters or fewer', () => {
    expect(maskModerationApiKey('abc')).toBe('••••');
    expect(maskModerationApiKey('sk-x')).toBe('sk-…');
    expect(maskModerationApiKey('12345678')).toBe('••••');
  });

  it('shows the last 4 of longer keys', () => {
    expect(maskModerationApiKey('sk-abcdefghijklmnopqrstuvwxyz')).toBe('sk-…wxyz');
    expect(maskModerationApiKey('plainlongsecretkey12')).toBe('••••ey12');
  });
});
