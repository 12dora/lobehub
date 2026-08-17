import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import app from '@/server/workflows-hono';

export const POST = async (request: Request) => {
  if (!(await isModuleEnabled('workflows')))
    return Response.json(
      { error: PLATFORM_ERROR_CODES.PLATFORM_MODULE_DISABLED, moduleId: 'workflows' },
      { status: 403 },
    );
  return app.fetch(request);
};
