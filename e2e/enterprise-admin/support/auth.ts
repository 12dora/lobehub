import type { APIRequestContext, BrowserContext } from '@playwright/test';
import { expect } from '@playwright/test';

export interface CredentialUser {
  email: string;
  password: string;
}

/**
 * Official better-auth email/password sign-in. No session table backdoors.
 */
export const signInWithPassword = async (
  request: APIRequestContext,
  user: CredentialUser,
  origin?: string,
): Promise<void> => {
  const headers: Record<string, string> = {};
  if (origin) {
    headers.Origin = origin;
    headers.Referer = `${origin}/`;
  }
  const response = await request.post('/api/auth/sign-in/email', {
    data: {
      email: user.email,
      password: user.password,
    },
    headers,
    maxRedirects: 0,
  });
  // better-auth may 200 or 302 with Set-Cookie; 307 without cookies is a hard fail.
  if (response.status() === 307 || response.status() === 301) {
    throw new Error(
      `official sign-in redirected (${response.status()}) without completing auth — check AUTH_TRUSTED_ORIGINS/Origin`,
    );
  }
  if (!response.ok() && response.status() !== 302) {
    const body = await response.text();
    throw new Error(
      `official sign-in failed for suite principal (status=${response.status()} body=${body.slice(0, 200)})`,
    );
  }
};

export const signInContext = async (
  context: BrowserContext,
  user: CredentialUser,
  baseURL?: string,
): Promise<void> => {
  await signInWithPassword(context.request, user, baseURL);
};

export const expectSignedIn = async (request: APIRequestContext): Promise<void> => {
  const session = await request.get('/api/auth/get-session');
  const status = session.status();
  if (status >= 300 && status < 400) {
    throw new Error(`get-session redirected (${status}) — session cookie missing`);
  }
  expect(session.ok(), 'session endpoint must succeed after sign-in').toBe(true);
  const contentType = session.headers()['content-type'] ?? '';
  if (!contentType.includes('json')) {
    throw new Error(`get-session returned non-JSON content-type=${contentType}`);
  }
  const json = (await session.json()) as { user?: { id?: string } | null };
  expect(json?.user?.id, 'missing browser/auth session — suite is blocked').toBeTruthy();
};
