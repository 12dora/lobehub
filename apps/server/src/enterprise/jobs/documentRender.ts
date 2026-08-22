import { isPersistentEnterpriseWorkerRuntime } from './persistentWorkerRuntime';
import type { PlatformJobDispatchHandlerContext } from './platformJobsDispatcher';

/** Handle one already-claimed `platform.document.render.v1` job. */
export const handleClaimedDocumentRenderJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<void> => {
  const { processClaimedDocumentRenderJob } = await import('../services/documentRender/worker');
  await processClaimedDocumentRenderJob(ctx);
};

/** Handle one already-claimed `platform.document.render.gc.v1` job. */
export const handleClaimedDocumentRenderGcJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<void> => {
  const { processClaimedDocumentRenderGcJob } = await import('../services/documentRender/gc');
  await processClaimedDocumentRenderGcJob(ctx);
};

/**
 * Registers this type with the merged `platform_jobs` dispatcher and clears
 * leftover `aihub-render/` temp dirs from a previous crash.
 */
export const ensureDocumentRenderWorkerStarted = (): void => {
  if (!isPersistentEnterpriseWorkerRuntime()) return;
  void import('../services/documentRender/queue').then(({ ensureDocumentRenderWorkerStarted }) => {
    ensureDocumentRenderWorkerStarted();
  });
};

export const isDocumentRenderWorkerRuntime = (
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean => isPersistentEnterpriseWorkerRuntime(env);
