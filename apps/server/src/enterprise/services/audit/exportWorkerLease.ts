/** Cancel / lease-loss / fencing-token guard for a running audit export attempt. */

import type { PlatformAuditExportModel, PlatformJobModel } from '@/database/models/platform';

import type { ArtifactWriter } from './exportWorkerArtifactWriter';
import { AuditExportCancelledError, AuditExportLeaseLostError } from './exportWorkerErrors';

export const createExportCancelGuard = (params: {
  artifact: ArtifactWriter;
  attemptToken: string;
  exportId: string;
  exportsModel: PlatformAuditExportModel;
  jobId: string;
  jobs: PlatformJobModel;
  leaseMs: number;
  workerId: string;
}): (() => Promise<void>) => {
  const { artifact, attemptToken, exportId, exportsModel, jobId, jobs, leaseMs, workerId } = params;

  return async () => {
    const current = await exportsModel.get(exportId);
    if (!current || current.status === 'cancelled') {
      throw new AuditExportCancelledError();
    }
    // Fencing: if another attempt rebound the token, stop without cancelling.
    const boundToken = (current.error as { attemptToken?: string } | null)?.attemptToken;
    if (boundToken && boundToken !== attemptToken) {
      throw new AuditExportLeaseLostError();
    }
    const job = await jobs.findById(jobId);
    if (!job || job.status === 'cancelled') {
      throw new AuditExportCancelledError();
    }
    // Renew lease + progress — null means lease loss, NOT user cancellation.
    const cp = await jobs.checkpoint({
      jobId,
      leaseMs,
      progressDone: Math.max(0, artifact.lineCount - 1),
      workerId,
    });
    if (!cp) {
      throw new AuditExportLeaseLostError();
    }
  };
};
