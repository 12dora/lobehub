export const CLOUD_SANDBOX_MARKET_AUTH_TOOL = {
  avatar: '💻',
  identifier: 'lobe-cloud-sandbox',
  label: 'Cloud Sandbox',
} as const;

export type MarketAuthTool = typeof CLOUD_SANDBOX_MARKET_AUTH_TOOL;

/**
 * Cloud Sandbox only needs a Market (community) profile when the server
 * provider is Market. Local Docker and Onlyboxes must not show that prompt.
 */
export const getMarketAuthTools = (
  sandboxProvider: 'local' | 'market' | 'onlyboxes' | undefined,
): MarketAuthTool[] => (sandboxProvider === 'market' ? [CLOUD_SANDBOX_MARKET_AUTH_TOOL] : []);
