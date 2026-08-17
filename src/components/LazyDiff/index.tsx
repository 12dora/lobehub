import { type CodeDiffProps, type PatchDiffProps, Skeleton } from '@lobehub/ui';
import { lazy, memo, Suspense } from 'react';

const loadDiff = () => import('./diff');

const LazyCodeDiff = lazy(async () => ({ default: (await loadDiff()).CodeDiff }));
const LazyPatchDiff = lazy(async () => ({ default: (await loadDiff()).PatchDiff }));

const DiffFallback = () => <Skeleton active paragraph={{ rows: 3 }} title={false} />;

/**
 * Drop-in replacements for `@lobehub/ui`'s `CodeDiff` / `PatchDiff` that load the
 * highlighter bundle on demand. See `./diff.ts` for why.
 */
export const CodeDiff = memo<CodeDiffProps>((props) => (
  <Suspense fallback={<DiffFallback />}>
    <LazyCodeDiff {...props} />
  </Suspense>
));

CodeDiff.displayName = 'LazyCodeDiff';

export const PatchDiff = memo<PatchDiffProps>((props) => (
  <Suspense fallback={<DiffFallback />}>
    <LazyPatchDiff {...props} />
  </Suspense>
));

PatchDiff.displayName = 'LazyPatchDiff';
