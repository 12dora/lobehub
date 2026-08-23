import debug from 'debug';

import { FileModel } from '@/database/models/file';
import { PlatformJobModel } from '@/database/models/platform/job';
import type { FileItem } from '@/database/schemas';
import type { PlatformJobDispatchHandlerContext } from '@/server/enterprise/jobs/platformJobsDispatcher';

import type { EffectiveDocumentRenderSettings } from '../documentRenderSettings';
import { getEffectiveDocumentRenderSettings } from '../documentRenderSettings';
import type { RenderControl } from './control';
import {
  clampJobTimeoutMs,
  FileDeletedDuringRenderError,
  heartbeatIntervalMs,
  RenderAbortedError,
  SidecarUnavailableError,
} from './control';
import {
  commitRenderOutcome,
  completeSkippedJob,
  failMissingFileId,
  persistFailedRender,
} from './persist';
import { runRender } from './pipeline';
import { clearDocumentRenderTempDir } from './queue';

const log = debug('lobe-server:document-render');

let tempCleared = false;
let activeJobs = 0;
const jobWaiters: Array<() => void> = [];

const withJobConcurrency = async <T>(limit: number, task: () => Promise<T>): Promise<T> => {
  const cap = Math.max(1, Math.floor(limit));
  await new Promise<void>((resolve) => {
    if (activeJobs < cap) {
      activeJobs += 1;
      resolve();
      return;
    }
    jobWaiters.push(() => {
      activeJobs += 1;
      resolve();
    });
  });
  try {
    return await task();
  } finally {
    activeJobs -= 1;
    const next = jobWaiters.shift();
    if (next) next();
  }
};

const ensureTempClearedOnce = async (): Promise<void> => {
  if (tempCleared) return;
  tempCleared = true;
  await clearDocumentRenderTempDir().catch((error) => {
    console.error('Failed to clear document-render temp dir', error);
  });
};

const createRenderControl = (controller: AbortController) => {
  let leaseLost = false;
  const control: RenderControl = {
    abortLease: () => {
      leaseLost = true;
      controller.abort();
    },
    assertLive: () => {
      if (!controller.signal.aborted) return;
      if (leaseLost) throw new RenderAbortedError('lease lost or cancelled');
      throw new Error('document render timed out');
    },
    signal: controller.signal,
  };
  return { control, isLeaseLost: () => leaseLost };
};

const startJobGuards = (params: {
  controller: AbortController;
  control: RenderControl;
  ctx: PlatformJobDispatchHandlerContext;
  jobs: PlatformJobModel;
  settings: EffectiveDocumentRenderSettings;
}): (() => void) => {
  const timeoutMs = clampJobTimeoutMs(params.settings.timeoutSec, params.ctx.spec.leaseMs);
  const timer = setTimeout(() => params.controller.abort(), timeoutMs);
  const intervalMs = heartbeatIntervalMs(params.ctx.spec.leaseMs);
  const heartbeatTimer = setInterval(() => {
    if (params.controller.signal.aborted) return;
    void params.jobs
      .heartbeat(params.ctx.job.id, params.ctx.workerId, params.ctx.spec.leaseMs)
      .then((row) => {
        if (!row) params.control.abortLease();
      })
      .catch((error) => {
        // A rejected call is not evidence the lease is gone — only a heartbeat that ANSWERS with
        // no row proves that, and the tick above already aborts on it. Killing an in-flight render
        // on one transient database blip would make renders more fragile than the unhandled
        // rejection this replaces; the next tick either succeeds or reports the lease lost.
        console.error('document render heartbeat failed', error);
      });
  }, intervalMs);
  return () => {
    clearInterval(heartbeatTimer);
    clearTimeout(timer);
  };
};

const handleClaimedRenderError = async (params: {
  error: unknown;
  file: FileItem;
  fileId: string;
  isLeaseLost: () => boolean;
  jobId: string;
  jobs: PlatformJobModel;
  logLostOwnership: (action: 'complete' | 'fail') => void;
  db: PlatformJobDispatchHandlerContext['db'];
  workerId: string;
}): Promise<void> => {
  const { error, fileId } = params;
  if (error instanceof SidecarUnavailableError) throw error;
  if (error instanceof FileDeletedDuringRenderError) {
    log('document render stopped, file deleted fileId=%s', fileId);
    await completeSkippedJob({
      jobId: params.jobId,
      jobs: params.jobs,
      logLostOwnership: params.logLostOwnership,
      workerId: params.workerId,
    });
    return;
  }
  if (error instanceof RenderAbortedError || params.isLeaseLost()) {
    log(
      'document render aborted fileId=%s: %s',
      fileId,
      error instanceof Error ? error.message : error,
    );
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  log('document render failed fileId=%s: %s', fileId, message);
  console.error('document render failed', error);
  const failed = await persistFailedRender({
    db: params.db,
    file: params.file,
    jobId: params.jobId,
    jobs: params.jobs,
    logLostOwnership: params.logLostOwnership,
    message,
    workerId: params.workerId,
  });
  if (!failed) return;
  throw error;
};

export const processClaimedDocumentRenderJob = async (
  ctx: PlatformJobDispatchHandlerContext,
): Promise<void> => {
  await ensureTempClearedOnce();
  const settings = await getEffectiveDocumentRenderSettings({ db: ctx.db });
  await withJobConcurrency(settings.concurrency, () =>
    processClaimedDocumentRenderJobInner(ctx, settings),
  );
};

const processClaimedDocumentRenderJobInner = async (
  ctx: PlatformJobDispatchHandlerContext,
  settings: EffectiveDocumentRenderSettings,
): Promise<void> => {
  const jobs = new PlatformJobModel(ctx.db);
  const fileId = typeof ctx.job.input?.fileId === 'string' ? ctx.job.input.fileId : '';
  const controller = new AbortController();
  const { control, isLeaseLost } = createRenderControl(controller);
  const stopGuards = startJobGuards({ controller, control, ctx, jobs, settings });

  const logLostOwnership = (action: 'complete' | 'fail') => {
    log('lost ownership on %s jobId=%s', action, ctx.job.id);
  };

  try {
    if (!fileId) {
      await failMissingFileId({
        jobId: ctx.job.id,
        jobs,
        logLostOwnership,
        workerId: ctx.workerId,
      });
      return;
    }

    const file = await FileModel.getFileById(ctx.db, fileId);
    if (!file) {
      await completeSkippedJob({
        jobId: ctx.job.id,
        jobs,
        logLostOwnership,
        workerId: ctx.workerId,
      });
      return;
    }

    try {
      const result = await runRender({
        control,
        db: ctx.db,
        file,
        jobId: ctx.job.id,
        jobs,
        leaseMs: ctx.spec.leaseMs,
        settings,
        workerId: ctx.workerId,
      });
      await commitRenderOutcome({
        db: ctx.db,
        file,
        jobId: ctx.job.id,
        jobs,
        logLostOwnership,
        result,
        workerId: ctx.workerId,
      });
    } catch (error) {
      await handleClaimedRenderError({
        db: ctx.db,
        error,
        file,
        fileId,
        isLeaseLost,
        jobId: ctx.job.id,
        jobs,
        logLostOwnership,
        workerId: ctx.workerId,
      });
    }
  } finally {
    stopGuards();
  }
};
