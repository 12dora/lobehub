/**
 * Ungated lazy tRPC sub-router.
 *
 * Same `NoInfer` trick as `moduleRouter`: inside `router({ ... })` the
 * contextual type is `Lazy<AnyRouter>`; without `NoInfer` TS fixes
 * `T = AnyRouter` from the return position and every client call site
 * loses procedure input/output types.
 */
import { type AnyRouter, type Lazy, lazy } from '@trpc/server/unstable-core-do-not-import';

export const lazyRouter = <T extends AnyRouter>(load: () => Promise<T>): Lazy<NoInfer<T>> =>
  lazy(load);
