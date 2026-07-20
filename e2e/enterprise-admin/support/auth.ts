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
): Promise<void> => {
  const response = await request.post('/api/auth/sign-in/email', {
    data: {
      email: user.email,
      password: user.password,
    },
  });
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `official sign-in failed for suite principal (status=${response.status()} body=${body.slice(0, 200)})`,
    );
  }
};

export const signInContext = async (
  context: BrowserContext,
  user: CredentialUser,
): Promise<void> => {
  await signInWithPassword(context.request, user);
};

export const expectSignedIn = async (request: APIRequestContext): Promise<void> => {
  const session = await request.get('/api/auth/get-session');
  expect(session.ok(), 'session endpoint must succeed after sign-in').toBe(true);
  const json = (await session.json()) as { user?: { id?: string } | null };
  expect(json?.user?.id, 'missing browser/auth session — suite is blocked').toBeTruthy();
};
