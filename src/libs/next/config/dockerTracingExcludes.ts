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
  // Non-linux (and non-x64/arm64 linux) koffi natives. Docker is linux glibc;
  // `static.cjs` has a `require()` per platform so tracing can pull them all in
  // when the image is built on macOS. `contains: true` also matches the
  // `.pnpm/@koromix+koffi-…/node_modules/@koromix/koffi-…` store copies.
  'node_modules/@koromix/koffi-darwin-*/**',
  'node_modules/@koromix/koffi-win32-*/**',
  'node_modules/@koromix/koffi-freebsd-*/**',
  'node_modules/@koromix/koffi-openbsd-*/**',
  'node_modules/@koromix/koffi-android-*/**',
  'node_modules/@koromix/koffi-*-ia32/**',
  'node_modules/@koromix/koffi-linux-riscv*/**',
  'node_modules/@koromix/koffi-linux-loong*/**',
  'node_modules/.pnpm/@koromix+koffi-darwin-*@*/**',
  'node_modules/.pnpm/@koromix+koffi-win32-*@*/**',
  'node_modules/.pnpm/@koromix+koffi-freebsd-*@*/**',
  'node_modules/.pnpm/@koromix+koffi-openbsd-*@*/**',
  'node_modules/.pnpm/@koromix+koffi-android-*@*/**',
  'node_modules/.pnpm/@koromix+koffi-*-ia32@*/**',
  'node_modules/.pnpm/@koromix+koffi-linux-riscv*@*/**',
  'node_modules/.pnpm/@koromix+koffi-linux-loong*@*/**',
];
