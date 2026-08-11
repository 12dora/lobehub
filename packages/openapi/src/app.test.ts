import { describe, expect, it, vi } from 'vitest';

vi.mock('./middleware/auth', () => ({
  userAuthMiddleware: async (_context: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./middleware/workspace', () => ({
  workspaceAuthMiddleware: async (_context: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('./routes', async () => {
  const { Hono } = await import('hono');
  const { HTTPException } = await import('hono/http-exception');
  const route = new Hono();
  route.get('/unauthorized', () => {
    throw new HTTPException(401, { message: 'Authentication required' });
  });

  return { default: { test: route } };
});

const { honoApp } = await import('./app');

describe('OpenAPI error handling', () => {
  it('preserves a middleware HTTPException 401 in the response envelope', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await honoApp.request('/api/v1/test/unauthorized');
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toMatchObject({
      error: 'Authentication required',
      success: false,
      timestamp: expect.any(String),
    });
  });
});
