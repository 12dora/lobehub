import path from 'node:path';

import { materializeDesktopBrandAssets } from './desktopBranding.mjs';

const sourceDirectory = process.argv[2];
const outputDirectory = process.argv[3];
if (!sourceDirectory || !outputDirectory) {
  throw new Error(
    'Usage: node materializeDesktopBrandAssets.mjs <source-directory> <output-directory>',
  );
}

await materializeDesktopBrandAssets({
  directory: path.resolve(outputDirectory),
  sourceDirectory: path.resolve(sourceDirectory),
});
console.info('AIHub desktop brand assets validated and materialized.');
