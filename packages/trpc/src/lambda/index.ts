/**
 * This is your entry point to setup the root configuration for tRPC on the server.
 * - `initTRPC` should only be used once per app.
 * - We export only the functionality that we use so we can enforce which base procedures should be used
 *
 * Learn how to create protected base procedures and other things below:
 * @link https://trpc.io/docs/v11/router
 * @link https://trpc.io/docs/v11/procedures
 */

import { openTelemetry } from '../middleware/openTelemetry';
import { userAuth } from '../middleware/userAuth';
import { trpc } from './init';
import { enterpriseAccessGate } from './middleware/enterpriseAccess';
import { heteroOperationAuth } from './middleware/heteroOperationAuth';
import { oidcAuth } from './middleware/oidcAuth';

/**
 * Create a router
 * @link https://trpc.io/docs/v11/router
 */
export const router = trpc.router;

/**
 * Create an unprotected procedure
 * @link https://trpc.io/docs/v11/procedures
 **/
const baseProcedure = trpc.procedure.use(openTelemetry);

export const publicProcedure = baseProcedure;

/**
 * Authenticated procedure + enterprise aihub.access gate (M02).
 * Gate is no-op when ENABLE_PLATFORM_ADMIN is off.
 * Allowlisted paths (platform.getAccessStatus, …) skip the gate.
 */
/** Authenticated but not yet aihub.access-gated. Use only for an env-only feature gate that must
 * short-circuit before every database-backed enterprise guard. Ordinary routes use authedProcedure. */
export const preAccessAuthedProcedure = baseProcedure.use(oidcAuth).use(userAuth);
export const authedProcedure = preAccessAuthedProcedure.use(enterpriseAccessGate);
export { enterpriseAccessGate } from './middleware/enterpriseAccess';

// procedure for hetero-agent ingest/finish endpoints — requires a `hetero-operation` JWT
// (no aihub.access gate — device/runtime paths are not user SPA session traffic)
export const heteroAuthedProcedure = baseProcedure.use(heteroOperationAuth).use(userAuth);

/**
 * Create a server-side caller
 * @link https://trpc.io/docs/v11/server/server-side-calls
 */
export const createCallerFactory = trpc.createCallerFactory;
