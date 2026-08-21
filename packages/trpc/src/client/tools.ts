import { createTRPCClient, httpBatchLink, type TRPCLink } from '@trpc/client';
import { observable } from '@trpc/server/observable';
import superjson from 'superjson';

import { type ToolsRouter } from '@/server/routers/tools';

// 401 error debouncing for market auth
let lastMarket401Time = 0;
const MIN_401_INTERVAL = 5000; // 5 seconds

const SANDBOX_MARKET_AUTH_PATH_MARKERS = [
  'execInSandbox',
  'exportAndUploadFile',
  'callCodeInterpreterTool',
] as const;

/**
 * Market OIDC (community sandbox) is only required when the server actually
 * routes Cloud Sandbox through LobeHub Market. Local Docker / Onlyboxes 401s
 * must not open that modal.
 */
export const shouldEmitMarketUnauthorized = (
  path: string,
  sandboxProvider: 'local' | 'market' | 'onlyboxes' | undefined,
): boolean => {
  if (!path.startsWith('market.')) return false;
  const isSandboxPath = SANDBOX_MARKET_AUTH_PATH_MARKERS.some((marker) => path.includes(marker));
  if (isSandboxPath && sandboxProvider !== 'market') return false;
  return true;
};

// Error handling link for tools client
const errorHandlingLink: TRPCLink<ToolsRouter> = () => {
  return ({ op, next }) =>
    observable((observer) =>
      next(op).subscribe({
        complete: () => observer.complete(),
        error: async (err) => {
          const status = err.data?.httpStatus as number;
          const code = err.data?.code as string;

          console.info('[toolsClient] Error:', {
            code,
            message: err.message,
            path: op.path,
            status,
          });

          // Check if this is a market API call with 401 error
          // UNAUTHORIZED tRPC code maps to HTTP 401
          const is401 = status === 401 || code === 'UNAUTHORIZED';
          if (is401 && op.path.startsWith('market.')) {
            const { getServerConfigStoreState } = await import('@/store/serverConfig');
            const sandboxProvider = getServerConfigStoreState()?.serverConfig.sandboxProvider;
            if (!shouldEmitMarketUnauthorized(op.path, sandboxProvider)) {
              observer.error(err);
              return;
            }

            const { getUserStoreState } = await import('@/store/user/store');
            // Without a LobeChat session a market.* 401 is not a Market auth
            // issue — let it bubble instead of triggering the auth modal
            if (getUserStoreState().isSignedIn) {
              const now = Date.now();
              if (now - lastMarket401Time > MIN_401_INTERVAL) {
                lastMarket401Time = now;
                console.info('[toolsClient] Emitting market-unauthorized event for path:', op.path);
                // Emit event for MarketAuthProvider to handle
                const { marketAuthEvents } =
                  await import('@/layout/AuthProvider/MarketAuth/events');
                const { pathToMarketAuthScene } =
                  await import('@/layout/AuthProvider/MarketAuth/scenes');
                marketAuthEvents.emit('market-unauthorized', {
                  path: op.path,
                  scene: pathToMarketAuthScene(op.path),
                  timestamp: now,
                });
              }
            }
          }

          observer.error(err);
        },
        next: (value) => observer.next(value),
      }),
    );
};

export const toolsClient = createTRPCClient<ToolsRouter>({
  links: [
    errorHandlingLink,
    httpBatchLink({
      headers: async () => {
        // dynamic import to avoid circular dependency
        const { createHeaderWithAuth } = await import('@/services/_auth');

        const headers = await createHeaderWithAuth();

        // Let business layer contribute extra headers (e.g. workspace context in Cloud).
        const { getBusinessTrpcHeaders } = await import('@/business/client/trpc-headers');
        Object.assign(headers as Record<string, string>, await getBusinessTrpcHeaders());

        return headers;
      },
      maxURLLength: 2083,
      transformer: superjson,
      url: '/trpc/tools',
    }),
  ],
});
