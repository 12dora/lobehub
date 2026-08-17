import type { AdminAgentListItem, AdminPlatformAgentSaveOutput } from './types';

/**
 * Fold a committed save/create into a cached list row.
 *
 * The save output IS authoritative for everything it carries — the advanced identity (revision,
 * draftSequence, currentVersionId, status), the new CAS token and the immutable version it just
 * published. Applying it before revalidating means the row matches the server the instant the
 * write commits, so a failed revalidation degrades to "the rest of this list may be behind"
 * instead of "the row still shows the value you replaced".
 */
export const applyAgentSaveOutputToListItem = (
  output: AdminPlatformAgentSaveOutput,
  item: AdminAgentListItem,
): AdminAgentListItem => ({
  ...item,
  displayName: output.version.config.displayName,
  identity: output.identity,
  publishedVersion: output.version.version,
});
