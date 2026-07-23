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
 * Authenticated procedure (OIDC/session + userAuth).
 * Authentik login is admission (external access gate removed).
 */
/** Alias kept for call sites that historically needed pre-access auth (env feature gates). */
export const preAccessAuthedProcedure = baseProcedure.use(oidcAuth).use(userAuth);
export const authedProcedure = preAccessAuthedProcedure;

// procedure for hetero-agent ingest/finish endpoints — requires a `hetero-operation` JWT
// (device/runtime paths are not user SPA session traffic)
export const heteroAuthedProcedure = baseProcedure.use(heteroOperationAuth).use(userAuth);

/**
 * Create a server-side caller
 * @link https://trpc.io/docs/v11/server/server-side-calls
 */
export const createCallerFactory = trpc.createCallerFactory;
