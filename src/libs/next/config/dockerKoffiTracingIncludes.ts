/**
 * Docker standalone `outputFileTracingIncludes` for `koffi`.
 *
 * koffi@3.1.5 has no install-time compile: `src/koffi/index.cjs` loads a prebuilt
 * `.node` from `@koromix/koffi-<os>-<arch>` via `require('@koromix/koffi-…')`
 * (`src/static.cjs`) and a relative `require(${__dirname}/../../../@koromix/koffi-${pkg})`.
 * Next.js output-file-tracing often misses that dynamic path, so we pin the files
 * the persistent ChatGPT Web transport needs at runtime.
 *
 * Mirror `dockerCanvasTracingIncludes`: do NOT use a broad
 * `node_modules/@koromix/koffi-linux-*` recursive glob (or `.pnpm/@koromix+koffi*`)
 * — Turbopack 16.3.0-preview.5 hashes the pnpm symlink *directory* as a file.
 * The `.node` lives at `<os>_<arch>/koffi.node`, not the package root.
 */
export const dockerKoffiTracingIncludes = [
  'node_modules/koffi/**/*',
  'node_modules/@koromix/koffi-linux-*/package.json',
  'node_modules/@koromix/koffi-linux-*/index.js',
  'node_modules/@koromix/koffi-linux-*/*/koffi.node',
  'node_modules/.pnpm/@koromix+koffi-linux-*/node_modules/@koromix/koffi-linux-*/package.json',
  'node_modules/.pnpm/@koromix+koffi-linux-*/node_modules/@koromix/koffi-linux-*/index.js',
  'node_modules/.pnpm/@koromix+koffi-linux-*/node_modules/@koromix/koffi-linux-*/*/koffi.node',
  // Virtual-store copy: koffi's relative require looks next to itself.
  'node_modules/.pnpm/koffi@*/node_modules/koffi/**/*',
  'node_modules/.pnpm/koffi@*/node_modules/@koromix/koffi-linux-*/package.json',
  'node_modules/.pnpm/koffi@*/node_modules/@koromix/koffi-linux-*/index.js',
  'node_modules/.pnpm/koffi@*/node_modules/@koromix/koffi-linux-*/*/koffi.node',
];
