import type { PlatformModuleId } from '@/const/platform/modules';
import { trpc } from '@/libs/trpc/lambda/init';

import { assertModuleEnabled } from '../services/moduleSettings';

/**
 * tRPC middleware: reject the procedure with PLATFORM_MODULE_DISABLED when the
 * named module is off. Routers stay mounted; this is a runtime gate only.
 */
export const withModule = (id: PlatformModuleId) =>
  trpc.middleware(async ({ next }) => {
    await assertModuleEnabled(id);
    return next();
  });
