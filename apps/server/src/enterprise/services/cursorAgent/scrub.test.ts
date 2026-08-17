// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { REDACTED, scrubJsonValue, scrubSecretString } from './scrub';

const TOKEN = 'test-cursor-session-jwt';
const OTHER_JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJvdGhlciJ9.signature';

describe('scrubSecretString', () => {
  it('replaces the exact session token and JWT-shaped values', () => {
    const out = scrubSecretString(`token=${TOKEN} other=${OTHER_JWT}`, TOKEN);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(OTHER_JWT);
    expect(out).toContain(REDACTED);
  });

  it('scrubs Bearer credentials and proxy userinfo in URLs', () => {
    const out = scrubSecretString(
      `Authorization: Bearer ${TOKEN} proxy=https://user:p4ss@proxy.example:8080`,
      TOKEN,
    );
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('user:p4ss');
    expect(out).toMatch(/Bearer /);
  });
});

describe('scrubJsonValue', () => {
  it('recursively scrubs string fields and leaves other types intact', () => {
    const scrubbed = scrubJsonValue(
      {
        count: 3,
        nested: { token: TOKEN, jwt: OTHER_JWT },
        ok: true,
        parts: [`Bearer ${TOKEN}`, OTHER_JWT],
      },
      TOKEN,
    ) as Record<string, unknown>;

    expect(scrubbed.count).toBe(3);
    expect(scrubbed.ok).toBe(true);
    const nested = scrubbed.nested as Record<string, unknown>;
    expect(nested.token).toBe(REDACTED);
    expect(nested.jwt).toBe(REDACTED);
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    expect(JSON.stringify(scrubbed)).not.toContain(OTHER_JWT);
  });
});
