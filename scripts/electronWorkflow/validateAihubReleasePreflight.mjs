import { appendFile } from 'node:fs/promises';

import { validateAihubReleaseInputs } from './aihubReleasePreflight.mjs';

const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error('GITHUB_OUTPUT is required');

const matrix = validateAihubReleaseInputs(process.env);
await appendFile(outputPath, `matrix=${JSON.stringify(matrix)}\n`);
console.info('AIHub desktop release inputs validated.');
