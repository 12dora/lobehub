// @vitest-environment node
import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from './route';

type RouteHandler = (request: Request) => Promise<Response>;

const mocks = vi.hoisted(() => ({
  get: vi.fn<RouteHandler>(async () => Response.json({ ok: true })),
  observeRawCallbackFailure: vi.fn(),
  post: vi.fn<RouteHandler>(async () => Response.json({ ok: true })),
}));

vi.mock('better-auth/next-js', () => ({
  toNextJsHandler: vi.fn(() => ({
    GET: mocks.get,
    POST: mocks.post,
  })),
}));

vi.mock('@/auth', () => ({
  auth: { $context: Promise.resolve({ internalAdapter: { id: 'adapter' } }) },
}));

vi.mock('@/libs/better-auth/sso/platformIdentityProviderObservation', () => ({
  observePlatformOidcRawCallbackFailure: mocks.observeRawCallbackFailure,
}));

const createPostRequest = (body: string, contentType = 'application/json') =>
  new Request('https://localhost/api/auth/sign-in/email', {
    body,
    headers: { 'Content-Type': contentType },
    method: 'POST',
  }) as NextRequest;

describe('/api/auth/[...all] route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mocks.get.mockResolvedValue(Response.json({ ok: true }));
    mocks.post.mockResolvedValue(Response.json({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 400 for malformed JSON auth requests before Better Auth handles them', async () => {
    const response = await POST(
      createPostRequest('{"email":"user@example.com","password":"secret",}'),
    );

    await expect(response.json()).resolves.toEqual({
      code: 'INVALID_JSON',
      message: 'Malformed JSON request body',
    });
    expect(response.status).toBe(400);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('passes valid JSON auth requests through without consuming the original body', async () => {
    mocks.post.mockImplementationOnce(async (request: Request) =>
      Response.json(await request.json()),
    );

    const response = await POST(
      createPostRequest(JSON.stringify({ email: 'user@example.com', password: 'secret' })),
    );

    await expect(response.json()).resolves.toEqual({
      email: 'user@example.com',
      password: 'secret',
    });
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('delegates non-JSON auth requests to Better Auth', async () => {
    const response = await POST(
      createPostRequest(
        'email=user%40example.com&password=secret',
        'application/x-www-form-urlencoded',
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it('fire-and-forgets raw callback failure observation without changing the response', async () => {
    const responseFromHandler = Response.json({ code: 'INTERNAL_SERVER_ERROR' }, { status: 500 });
    let finishObservation: (() => void) | undefined;
    mocks.observeRawCallbackFailure.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishObservation = resolve;
      }),
    );
    mocks.get.mockResolvedValueOnce(responseFromHandler);
    const request = new Request(
      'https://localhost/api/auth/oauth2/callback/corp-oidc?state=opaque',
    ) as NextRequest;

    const response = await GET(request);
    await vi.waitFor(() => expect(mocks.observeRawCallbackFailure).toHaveBeenCalledOnce());

    expect(response).toBe(responseFromHandler);
    expect(mocks.observeRawCallbackFailure).toHaveBeenCalledWith(
      { id: 'adapter' },
      request,
      responseFromHandler,
    );
    finishObservation?.();
  });

  it('delegates GET requests to Better Auth', async () => {
    const request = new Request('https://localhost/api/auth/get-session') as NextRequest;

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(request);
  });

  it('blocks Better Auth admin mutations when platform admin is on', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    for (const path of [
      '/admin/ban-user',
      '/admin/unban-user',
      '/admin/revoke-user-sessions',
      '/admin/set-role',
      '/admin/remove-user',
      '/admin/impersonate-user',
      '/admin/set-user-password',
    ]) {
      const response = await POST(
        new Request(`https://localhost/api/auth${path}`, {
          body: '{}',
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }) as NextRequest,
      );
      expect(response.status).toBe(403);
      expect(mocks.post).not.toHaveBeenCalled();
      mocks.post.mockClear();
    }
  });

  it('allows Better Auth admin paths when platform admin is off', async () => {
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '0');
    const response = await POST(
      new Request('https://localhost/api/auth/admin/ban-user', {
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }) as NextRequest,
    );
    expect(response.status).toBe(200);
    expect(mocks.post).toHaveBeenCalled();
  });
});
