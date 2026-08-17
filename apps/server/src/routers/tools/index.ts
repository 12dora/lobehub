import { publicProcedure, router } from '@/libs/trpc/lambda';
import { lazyRouter } from '@/server/enterprise/routers/lazyRouter';
import { moduleRouter } from '@/server/enterprise/routers/moduleRouter';

export const toolsRouter = router({
  healthcheck: publicProcedure.query(() => "i'm live!"),
  composio: lazyRouter(() => import('./composio').then((m) => m.composioToolsRouter)),

  market: moduleRouter('market', () => import('./market').then((m) => m.marketRouter)),
  mcp: lazyRouter(() => import('./mcp').then((m) => m.mcpRouter)),
  search: moduleRouter('webSearch', () => import('./search').then((m) => m.searchRouter)),
});

export type ToolsRouter = typeof toolsRouter;
