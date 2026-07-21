import { builtinTools } from '@lobechat/builtin-tools';

import type { AdminConnectorListItem } from './types';

/** Synthetic id prefix for code-bundled built-in connectors (no platform DB row). */
const BUILTIN_CONNECTOR_PREFIX = 'builtin:';

export const isBuiltinConnectorId = (id: string | undefined): id is string =>
  Boolean(id?.startsWith(BUILTIN_CONNECTOR_PREFIX));

const EMPTY_SECRET = { configured: false, fingerprint: null, updatedAt: null } as const;

/** The same set the user Settings > Connector "Built-in Tools" section shows (non-hidden). */
const visibleBuiltinTools = () => builtinTools.filter((tool) => !tool.hidden);

/**
 * Read-only list rows for the code-bundled built-in connectors/tools so the admin
 * catalog shows the same built-ins the user page does. These are in-process tools
 * with no endpoint/credential and are always live for every user, so they are shown
 * read-only; a real DB draft with the same key shadows them (deduped in the page).
 */
export const buildBuiltinConnectorListItems = (): AdminConnectorListItem[] =>
  visibleBuiltinTools().map((tool, index) => ({
    connectionTest: null,
    credentialMode: 'none',
    description: tool.manifest.meta.description ?? null,
    displayName: tool.manifest.meta.title || tool.identifier,
    enabled: true,
    // Placeholder — built-ins have no HTTP endpoint; never parsed or probed.
    endpoint: `https://builtin.invalid/${tool.identifier}`,
    id: `${BUILTIN_CONNECTOR_PREFIX}${tool.identifier}`,
    key: tool.identifier,
    oauthClientSecret: EMPTY_SECRET,
    oauthConfig: null,
    revision: 0,
    sharedSecret: EMPTY_SECRET,
    sort: index,
    status: 'published',
    transport: 'http',
  }));

export interface BuiltinConnectorView {
  description: string | null;
  displayName: string;
  key: string;
}

export const getBuiltinConnectorView = (id: string): BuiltinConnectorView | null => {
  const tool = visibleBuiltinTools().find(
    (item) => `${BUILTIN_CONNECTOR_PREFIX}${item.identifier}` === id,
  );
  if (!tool) return null;
  return {
    description: tool.manifest.meta.description ?? null,
    displayName: tool.manifest.meta.title || tool.identifier,
    key: tool.identifier,
  };
};
