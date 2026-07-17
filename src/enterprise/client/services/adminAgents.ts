import { createMockAdminAgentsClient } from '../features/admin/agents/mockAdminAgents';
import type { AdminAgentsClient } from '../features/admin/agents/types';

/**
 * PR-050 adapter seam. The mock keeps the UI executable while PR-048/049/052 routers land.
 * Integration replaces this singleton with the TRPC-backed implementation, without changing UI hooks.
 */
export const adminAgentsService: AdminAgentsClient = createMockAdminAgentsClient();
