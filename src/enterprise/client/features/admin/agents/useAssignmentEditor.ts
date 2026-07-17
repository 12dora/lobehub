'use client';

import { useState } from 'react';

import { adminAgentsService } from '@/enterprise/client/services/adminAgents';

import type {
  AdminAgentAssignmentPreviewOutput,
  AdminAgentDetailOutput,
  AdminPlatformAgentAssignmentUpsertInput,
} from './types';

export const useAssignmentEditor = (
  snapshot: AdminAgentDetailOutput,
  refresh: () => Promise<AdminAgentDetailOutput | undefined>,
) => {
  const [targetType, setTargetType] =
    useState<AdminPlatformAgentAssignmentUpsertInput['targetType']>('global');
  const [targetId, setTargetId] = useState('__global__');
  const [mode, setMode] = useState<AdminPlatformAgentAssignmentUpsertInput['mode']>('optional');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<AdminAgentAssignmentPreviewOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignment = {
    enabled: true,
    mode,
    pinnedVersionId: null,
    targetId: targetType === 'global' ? '__global__' : targetId.trim(),
    targetType,
    versionPolicy: 'latest_published' as const,
  };

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const previewAssignment = () =>
    run(async () => {
      const output = await adminAgentsService.previewAssignment({
        agentId: snapshot.identity.id,
        assignment,
      });
      setPreview(output);
    });

  const createAssignment = () =>
    run(async () => {
      await adminAgentsService.upsertAssignment({
        agentId: snapshot.identity.id,
        ...assignment,
        expectedDraftToken: snapshot.draftToken,
        expectedRevision: snapshot.identity.revision,
        reason: reason.trim(),
      });
      await refresh();
      setPreview(null);
      setReason('');
    });

  return {
    assignment,
    busy,
    createAssignment,
    error,
    mode,
    preview,
    previewAssignment,
    reason,
    setMode,
    setReason,
    setTargetId,
    setTargetType: (value: AdminPlatformAgentAssignmentUpsertInput['targetType']) => {
      setTargetType(value);
      setTargetId(value === 'global' ? '__global__' : '');
      setPreview(null);
    },
    targetId,
    targetType,
  };
};
