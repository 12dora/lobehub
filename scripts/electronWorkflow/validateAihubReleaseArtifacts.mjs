import path from 'node:path';

import { validateAihubReleaseArtifacts } from './desktopBranding.mjs';

const releaseDirectory = process.argv[2];
if (!releaseDirectory) {
  throw new Error('Usage: node validateAihubReleaseArtifacts.mjs <release-directory>');
}

await validateAihubReleaseArtifacts(path.resolve(releaseDirectory));
console.info('AIHub release artifacts and update manifests are brand-isolated.');
