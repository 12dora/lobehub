import type {
  AdminAgentDetailOutput,
  AdminAgentListItem,
  AdminPlatformAgentSaveOutput,
} from './types';
import { sortPlatformAgentVersionsDesc } from './versionSelection';

/**
 * Fold a committed save/create into a cached detail aggregate.
 *
 * The save output IS authoritative for everything it carries — the advanced identity (revision,
 * draftSequence, currentVersionId, status), the new CAS token and the immutable version it just
 * published. Applying it before revalidating means the screen matches the server the instant the
 * write commits, so a failed revalidation degrades to "the rest of this page may be behind"
 * instead of "the page still shows the value you replaced".
 */
export const applyAgentSaveOutputToDetail =
  (output: AdminPlatformAgentSaveOutput) =>
  (current?: AdminAgentDetailOutput): AdminAgentDetailOutput | undefined => {
    if (!current) return current;
    // The version is immutable and keyed by id, so a re-applied output can never duplicate a row.
    const versions = current.versions.filter(({ id }) => id !== output.version.id);
    return {
      ...current,
      draftToken: output.draftToken,
      identity: output.identity,
      versions: sortPlatformAgentVersionsDesc([
        output.version,
        ...versions,
      ] as AdminAgentDetailOutput['versions']),
    };
  };

/**
 * Fold the same output into a cached list row: identity CAS, the published version label and the
 * (possibly renamed) display name all come straight from the committed version.
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
