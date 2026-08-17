/**
 * Docker standalone `outputFileTracingExcludes['*']`.
 *
 * Next applies these via picomatch({ contains: true }) on the next-server
 * trace. A bare `dist/**` (or `./dist/**` — `.` is "any char") also matches
 * `node_modules/next/dist/**` and drops `app-route-turbo.runtime.prod.js`.
 * Keep Vite intermediates as explicit subdirs only.
 *
 * Do NOT exclude `src/`, `packages/`, or `apps/server` — a cwd-wide trace
 * (G0 §D, `path.resolve(process.cwd(), <const>)`) can still need those trees.
 * Dockerfile copies migrations separately to `/app/migrations`.
 */
export const dockerTracingExcludes = (): string[] => [
  'dist/desktop/**',
  'dist/mobile/**',
  'dist/auth/**',
  'apps/desktop/**',
  'apps/cli/**',
  'e2e/**',
  'tests/**',
  '**/*.tsbuildinfo',
  'packages/database/migrations/**',
  'changelog/**',
  'docker-compose/**',
  // Extra canvas natives: require('@napi-rs/canvas') + js-binding.js resolve
  // the hoisted /app/node_modules/@napi-rs/canvas-linux-* copy. The two
  // .pnpm trees are byte-identical 26 MiB files (do not exclude the hoisted
  // path). Busybox prune in the Dockerfile is the belt if includes win.
  'node_modules/.pnpm/@napi-rs+canvas@*/node_modules/@napi-rs/canvas-*/*.node',
  'node_modules/.pnpm/@napi-rs+canvas-linux-*@*/node_modules/@napi-rs/canvas-*/*.node',
];
