// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getAuthConfig', () => {
  const originalPrefix = process.env.AUTH_COOKIE_PREFIX;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.AUTH_COOKIE_PREFIX;
  });

  afterEach(() => {
    if (originalPrefix === undefined) {
      delete process.env.AUTH_COOKIE_PREFIX;
    } else {
      process.env.AUTH_COOKIE_PREFIX = originalPrefix;
    }
  });

  describe('AUTH_COOKIE_PREFIX', () => {
    it('is undefined when unset or empty (default cookie names)', async () => {
      const { getAuthConfig } = await import('../auth');
      expect(getAuthConfig().AUTH_COOKIE_PREFIX).toBeUndefined();

      process.env.AUTH_COOKIE_PREFIX = '';
      expect(getAuthConfig().AUTH_COOKIE_PREFIX).toBeUndefined();
    });

    it('accepts RFC 6265 token-safe prefixes', async () => {
      const { getAuthConfig } = await import('../auth');
      process.env.AUTH_COOKIE_PREFIX = 'aihub-3011_A';
      expect(getAuthConfig().AUTH_COOKIE_PREFIX).toBe('aihub-3011_A');
    });

    it.each([
      ['separator injection', 'aihub.session'],
      ['whitespace', 'aihub 3011'],
      ['header-breaking characters', 'aihub;Path=/'],
      ['over 40 characters', 'a'.repeat(41)],
    ])('rejects %s', async (_label, value) => {
      const { getAuthConfig } = await import('../auth');
      process.env.AUTH_COOKIE_PREFIX = value;
      expect(() => getAuthConfig()).toThrow();
    });
  });
});
