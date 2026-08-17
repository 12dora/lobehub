/**
 * Lazy tRPC sub-router gated by a platform module.
 *
 * Design (G3):
 *   tRPC 11.18 exports `lazy()` from `@trpc/server/unstable-core-do-not-import`
 *   (not the public `@trpc/server` barrel). That is the right primitive:
 *     - no `import()` at module-evaluation time;
 *     - tRPC memoizes the loader with `once()` (import happens once);
 *     - `DecorateCreateRouterOptions` unwraps `Lazy<T>` to `T`'s procedure
 *       record, so `LambdaRouter` / client types do not drift.
 *
 *   After the lazy import we wrap every procedure with a *hot*
 *   `isModuleEnabled(moduleId)` check. Built procedures do not expose a public
 *   `.use()` in v11, so the wrapper is a call-site function that preserves
 *   `_def` (input / type / existing middleware metadata) and is rebuilt via
 *   `createRouterFactory(source._def._config)` — same lambda vs async root
 *   config, `.use()`-compatible shape. A disabled module still pays the import
 *   on first call (needed to keep the real procedure paths) and then throws
 *   `PLATFORM_MODULE_DISABLED` / FORBIDDEN with `details.moduleId`.
 */
import {
  type AnyProcedure,
  type AnyRouter,
  createRouterFactory,
  type CreateRouterOptions,
  type Lazy,
  lazy,
  type RouterRecord,
} from '@trpc/server/unstable-core-do-not-import';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformModuleId } from '@/const/platform/modules';

import { throwEnterpriseError } from '../guards/enterpriseErrors';
import { isModuleEnabled } from '../services/moduleSettings';

export type ModuleRouterLoad<T extends AnyRouter> =
  T | { default?: T } | Record<string, T | unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isRouter = (value: unknown): value is AnyRouter =>
  isRecord(value) && isRecord(value._def) && value._def.router === true;

const isProcedure = (value: unknown): value is AnyProcedure => typeof value === 'function';

export const throwModuleDisabled = (moduleId: PlatformModuleId): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
    details: { moduleId },
    httpCode: 'FORBIDDEN',
    message: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED,
  });

export const resolveLoadedRouter = <T extends AnyRouter>(
  mod: ModuleRouterLoad<T>,
  pick?: (mod: ModuleRouterLoad<T>) => T,
): T => {
  if (pick) return pick(mod);
  if (isRouter(mod)) return mod;
  if (isRecord(mod) && isRouter(mod.default)) return mod.default as T;

  if (isRecord(mod)) {
    const routers = Object.values(mod).filter(isRouter);
    if (routers.length === 1) return routers[0] as T;
  }

  throw new Error(
    'moduleRouter: expected exactly one tRPC router export (or pass pick). Example: `moduleRouter(id, () => import("./x").then((m) => m.xRouter))`',
  );
};

const wrapProcedure = (procedure: AnyProcedure, moduleId: PlatformModuleId): AnyProcedure => {
  const wrapped = (async (opts) => {
    if (!(await isModuleEnabled(moduleId))) {
      throwModuleDisabled(moduleId);
    }
    return procedure(opts);
  }) as AnyProcedure;

  wrapped._def = procedure._def;
  return wrapped;
};

const wrapRecord = (record: RouterRecord, moduleId: PlatformModuleId): CreateRouterOptions => {
  const next: CreateRouterOptions = {};
  for (const [key, value] of Object.entries(record)) {
    if (isProcedure(value)) {
      next[key] = wrapProcedure(value, moduleId);
      continue;
    }
    if (isRouter(value)) {
      next[key] = wrapWithModuleGuard(value, moduleId);
      continue;
    }
    if (isRecord(value)) {
      next[key] = wrapRecord(value as RouterRecord, moduleId);
    }
  }
  return next;
};

/** Rebuild `source` so every procedure hot-checks `moduleId`. */
export const wrapWithModuleGuard = <T extends AnyRouter>(
  source: T,
  moduleId: PlatformModuleId,
): T => createRouterFactory(source._def._config)(wrapRecord(source._def.record, moduleId)) as T;

/**
 * Mount a module-gated lazy sub-router whose type is `T`.
 *
 * @example
 * knowledgeBase: moduleRouter('knowledgeBase', () =>
 *   import('./knowledgeBase').then((m) => m.knowledgeBaseRouter),
 * ),
 */
export const moduleRouter = <T extends AnyRouter>(
  moduleId: PlatformModuleId,
  // Typed as `() => Promise<T>` on purpose: inferring `T` from a union with
  // `Record<string, unknown>` collapses to `AnyRouter` and every client
  // `.query`/`.mutate` on the lazy sub-router stops type-checking.
  load: () => Promise<T>,
  pick?: (mod: ModuleRouterLoad<T>) => T,
  // `NoInfer`: inside `router({ ... })` the contextual type is `Lazy<AnyRouter>`;
  // without it TS fixes `T = AnyRouter` from the return position and the whole
  // sub-router collapses to `RouterRecord` for every client (same trick as tRPC's own `lazy()`).
): Lazy<NoInfer<T>> =>
  lazy(async () => {
    const loaded = (await load()) as ModuleRouterLoad<T>;
    return wrapWithModuleGuard(resolveLoadedRouter(loaded, pick), moduleId);
  });
