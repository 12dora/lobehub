import '../initialize';

import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';

import { registerBrandIcons } from '@/const/brandIcons';
import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';
import { bootTiming } from '@/libs/bootTiming';
import { createAppRouter } from '@/utils/router';

import { startAppInitialization } from './initialize/bootstrap';
import { mobileRoutes } from './router/mobileRouter.config';

// Brand icons must be registered into `@lobehub/icons`' mapping arrays before any provider/model
// icon renders. Called explicitly (not a bare side-effect import): the root package.json marks
// only the entries as side-effectful, so a bare import would be tree-shaken out of production.
// Kept out of the auth entry, which renders no icons.
registerBrandIcons();

bootTiming.mark('bundle-eval');
startAppInitialization();

const router = createAppRouter(mobileRoutes);

createRoot(document.getElementById('root')!).render(
  <NextThemeProvider>
    <RouterProvider router={router} />
  </NextThemeProvider>,
);
