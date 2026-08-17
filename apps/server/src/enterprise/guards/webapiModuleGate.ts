/**
 * Hot webapi / Hono gate: path prefix → platform module.
 *
 * Disabled modules answer 403 `{ error: 'PLATFORM_MODULE_DISABLED', moduleId }`
 * (never 404). Unmapped paths pass through — they are core.
 */
import type { MiddlewareHandler } from 'hono';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformModuleId } from '@/const/platform/modules';

import { isModuleEnabled } from '../services/moduleSettings';

export interface WebapiModulePrefix {
  moduleId: PlatformModuleId;
  prefix: string;
}

/**
 * Longest-prefix-first. Derived from the agent-hono handler list plus the
 * workflows-hono mounts that live under `/api/workflows`.
 */
export const WEBAPI_MODULE_PREFIXES: readonly WebapiModulePrefix[] = [
  { moduleId: 'bots', prefix: '/api/agent/gateway' },
  { moduleId: 'bots', prefix: '/api/agent/webhooks' },
  { moduleId: 'bots', prefix: '/api/agent/messenger' },
  { moduleId: 'agentSignal', prefix: '/api/workflows/agent-signal' },
  { moduleId: 'memory', prefix: '/api/workflows/memory-user-memory' },
  { moduleId: 'workflows', prefix: '/api/workflows' },
];

const canonicalize = (path: string): string => {
  const withoutQuery = path.split('?')[0] ?? path;
  if (withoutQuery.startsWith('/api/')) return withoutQuery;
  // Hono `basePath` mounts sometimes report the suffix only.
  if (
    withoutQuery.startsWith('/agent-signal') ||
    withoutQuery.startsWith('/memory-user-memory') ||
    withoutQuery.startsWith('/task') ||
    withoutQuery.startsWith('/verify')
  ) {
    return `/api/workflows${withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`}`;
  }
  return `/api/agent${withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`}`;
};

/** Launcher polls this path; the handler must answer 200 `{ ok:false, disabled:true }`. */
const GATEWAY_START_PATH = '/api/agent/gateway/start';

export const resolveWebapiModuleId = (path: string): PlatformModuleId | undefined => {
  const canonical = canonicalize(path);
  if (canonical === GATEWAY_START_PATH) return undefined;
  for (const { prefix, moduleId } of WEBAPI_MODULE_PREFIXES) {
    if (canonical === prefix || canonical.startsWith(`${prefix}/`)) return moduleId;
  }
  return undefined;
};

export const platformModuleDisabledBody = (moduleId: PlatformModuleId) =>
  ({ error: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED, moduleId }) as const;

export const gateWebapiRequest = async (request: Request): Promise<Response | null> => {
  const moduleId = resolveWebapiModuleId(new URL(request.url).pathname);
  if (!moduleId) return null;
  if (await isModuleEnabled(moduleId)) return null;
  return Response.json(platformModuleDisabledBody(moduleId), { status: 403 });
};

export const webapiModuleGate: MiddlewareHandler = async (c, next) => {
  const moduleId = resolveWebapiModuleId(c.req.path);
  if (!moduleId) return next();
  if (await isModuleEnabled(moduleId)) return next();
  return c.json(platformModuleDisabledBody(moduleId), 403);
};

type WorkflowsRouteHandler = (request: Request, context?: unknown) => Promise<Response> | Response;

/** One-line wrap for concrete /api/workflows/.../route.ts POST exports. */
export const withWorkflowsModule = (handler: WorkflowsRouteHandler): WorkflowsRouteHandler => {
  return async (request, context) => {
    const denied = await gateWebapiRequest(request);
    if (denied) return denied;
    return handler(request, context);
  };
};
