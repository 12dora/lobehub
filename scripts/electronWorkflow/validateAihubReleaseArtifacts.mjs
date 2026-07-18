import path from 'node:path';

import { validateAihubReleaseArtifacts } from './desktopReleaseArtifacts.mjs';

const releaseDirectory = process.argv[2];
const expectedPrefix = process.argv[3];
if (!releaseDirectory) {
  throw new Error('Usage: node validateAihubReleaseArtifacts.mjs <release-directory>');
}

await validateAihubReleaseArtifacts(path.resolve(releaseDirectory), { expectedPrefix });
console.info('AIHub release artifacts and update manifests are brand-isolated.');
