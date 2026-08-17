/**
 * Dynamic-import boundary for `@lobehub/ui`'s diff viewers.
 *
 * `CodeDiff` / `PatchDiff` statically pull `@pierre/diffs`, which ships its own
 * shiki copy with every bundled grammar and theme (~7.9MB in the built bundle).
 * Keeping the re-export in a module that is only ever `import()`ed lets the
 * bundler tree-shake those bindings out of the `@lobehub/ui` barrel on the
 * first-screen graph, so the diff viewer is fetched the first time a diff is
 * actually rendered.
 *
 * Never import this module statically — import `@/components/LazyDiff` instead.
 */
export { CodeDiff, PatchDiff } from '@lobehub/ui';
