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
];
