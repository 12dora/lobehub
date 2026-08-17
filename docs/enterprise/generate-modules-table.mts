/**
 * Regenerates the module table in docs/enterprise/modules.md from
 * packages/const/src/platform/modules.ts so the two cannot drift.
 *
 *   bun docs/enterprise/generate-modules-table.mts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  modulesForPreset,
  PLATFORM_MODULE_IDS,
  PLATFORM_MODULES,
} from '../../packages/const/src/platform/modules';

const docPath = path.resolve(import.meta.dirname, 'modules.md');
const BEGIN = '<!-- BEGIN MODULE TABLE -->';
const END = '<!-- END MODULE TABLE -->';

const presets = ['minimal', 'standard', 'full'] as const;
const enabled = Object.fromEntries(presets.map((p) => [p, modulesForPreset(p)]));
const mark = (id: (typeof PLATFORM_MODULE_IDS)[number], p: (typeof presets)[number]) =>
  enabled[p].has(id) ? '✓' : '✗';

const rows = PLATFORM_MODULE_IDS.map((id) => {
  const m = PLATFORM_MODULES[id];
  const cost = [
    m.cost.idleRssMb == null ? 'rss ?' : `rss ${m.cost.idleRssMb}MB`,
    `${m.cost.backgroundJobs} jobs`,
    m.cost.loadKind,
    m.cost.loadSensitive ? 'load-sensitive' : null,
    m.cost.subprocess ? 'subprocess' : null,
    m.cost.externalDeps.length ? m.cost.externalDeps.join('+') : null,
  ]
    .filter(Boolean)
    .join(', ');
  return `| \`${id}\` | ${m.origin} | ${m.tier} | ${m.kind} | ${mark(id, 'minimal')} | ${mark(id, 'standard')} | ${mark(id, 'full')} | ${cost} |`;
});

const table = [
  '| id | origin | tier | kind | minimal | standard | full | cost |',
  '|---|---|---|---|---|---|---|---|',
  ...rows,
].join('\n');

const doc = readFileSync(docPath, 'utf8');
const start = doc.indexOf(BEGIN);
const stop = doc.indexOf(END);
if (start < 0 || stop < 0 || stop < start) {
  throw new Error(`markers ${BEGIN} / ${END} not found in ${docPath}`);
}

const next = doc.slice(0, start + BEGIN.length) + '\n\n' + table + '\n\n' + doc.slice(stop);
writeFileSync(docPath, next);
console.info(`updated ${docPath} (${PLATFORM_MODULE_IDS.length} modules)`);
