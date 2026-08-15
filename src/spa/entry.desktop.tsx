import '../initialize';
// Side-effect FIRST: brand icons register into `@lobehub/icons`' mapping arrays before any
// provider/model icon renders (kept out of the auth entry, which renders no icons).
import '@/const/brandIcons';

import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';

import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';
import { bootTiming } from '@/libs/bootTiming';
import { createAppRouter } from '@/utils/router';

import { startAppInitialization } from './initialize/bootstrap';
import { desktopRoutes } from './router/desktopRouter.config';

bootTiming.mark('bundle-eval');
startAppInitialization();

const router = createAppRouter(desktopRoutes);

createRoot(document.getElementById('root')!).render(
  <NextThemeProvider>
    <RouterProvider router={router} />
  </NextThemeProvider>,
);
