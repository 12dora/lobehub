import { asyncRouter as router, publicProcedure } from '@/libs/trpc/async';
import { lazyRouter } from '@/server/enterprise/routers/lazyRouter';
import { moduleRouter } from '@/server/enterprise/routers/moduleRouter';

export const asyncRouter = router({
  document: lazyRouter(() => import('./document').then((m) => m.documentRouter)),
  file: lazyRouter(() => import('./file').then((m) => m.fileRouter)),
  healthcheck: publicProcedure.query(() => "i'm live!"),
  image: moduleRouter('imageGen', () => import('./image').then((m) => m.imageRouter)),
  ragEval: moduleRouter('knowledgeBase', () => import('./ragEval').then((m) => m.ragEvalRouter)),
  video: moduleRouter('imageGen', () => import('./video').then((m) => m.videoRouter)),
});

export type AsyncRouter = typeof asyncRouter;

export type { UnifiedAsyncCaller } from './caller';
export { createAsyncCaller, createAsyncServerClient } from './caller';
