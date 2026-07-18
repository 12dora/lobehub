import path from 'node:path';

import { materializeDesktopBrandAssets } from './desktopBranding.mjs';

const outputDirectory = process.argv[2];
if (!outputDirectory) {
  throw new Error('Usage: node materializeDesktopBrandAssets.mjs <output-directory>');
}

await materializeDesktopBrandAssets({ directory: path.resolve(outputDirectory) });
console.info('AIHub desktop brand assets validated and materialized.');
