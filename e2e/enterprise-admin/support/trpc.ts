import type { APIRequestContext } from '@playwright/test';

/**
 * tRPC lambda HTTP helpers (batch=1 query shape used by the product client).
 * Cookie jar is owned by the Playwright request/context — never logged.
 */
const emptyInput = encodeURIComponent(JSON.stringify({ 0: { json: null } }));

const parseJsonBody = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

export const trpcQuery = async (
  request: APIRequestContext,
  path: string,
  input: unknown = null,
): Promise<{ ok: boolean; status: number; text: string; json: unknown }> => {
  const encoded =
    input === null ? emptyInput : encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  const response = await request.get(`/trpc/lambda/${path}?batch=1&input=${encoded}`, {
    timeout: 120_000,
  });
  const text = await response.text();
  return { json: parseJsonBody(text), ok: response.ok(), status: response.status(), text };
};

export const trpcMutation = async (
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<{ ok: boolean; status: number; text: string; json: unknown }> => {
  const response = await request.post(`/trpc/lambda/${path}?batch=1`, {
    data: { 0: { json: input } },
    headers: {
      'content-type': 'application/json',
    },
    timeout: 120_000,
  });
  const text = await response.text();
  return { json: parseJsonBody(text), ok: response.ok(), status: response.status(), text };
};

/** Extract tRPC error code from a batch response body without dumping secrets. */
export const extractTrpcErrorCode = (body: string): string | undefined => {
  const messageMatch = body.match(
    /"(PLATFORM_[A-Z0-9_]+|RESOURCE_MANAGED_BY_PLATFORM|FORBIDDEN|UNAUTHORIZED)"/,
  );
  if (messageMatch?.[1]) return messageMatch[1];
  const codeMatch = body.match(/"code"\s*:\s*"([A-Z_]+)"/);
  return codeMatch?.[1];
};

export const bodyHasForbidden = (body: string): boolean =>
  /FORBIDDEN|PLATFORM_PERMISSION_DENIED|RESOURCE_MANAGED_BY_PLATFORM|hasAdminAccess":false/i.test(
    body,
  );
