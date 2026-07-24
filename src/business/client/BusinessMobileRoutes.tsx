import { type RouteObject } from 'react-router';

import { getEnterpriseMobileRoutesWithoutMainLayout } from '@/enterprise/client/routes/mobile';

export const BusinessMobileRoutesWithMainLayout: RouteObject[] = [];
export const BusinessMobileRoutesWithSettingsLayout: RouteObject[] = [];

/**
 * Declarative business mount: mobile admin routes come from enterprise only.
 */
export const BusinessMobileRoutesWithoutMainLayout: RouteObject[] =
  getEnterpriseMobileRoutesWithoutMainLayout();
