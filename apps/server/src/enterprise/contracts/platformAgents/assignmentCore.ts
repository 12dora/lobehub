import {
  PLATFORM_AGENT_ASSIGNMENT_MODES,
  PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES,
  PLATFORM_AGENT_GLOBAL_TARGET_ID,
  PLATFORM_AGENT_VERSION_POLICIES,
} from '@lobechat/types';
import { z } from 'zod';

import { idSchema } from './common';

export type PlatformAgentAssignmentCore = {
  enabled: boolean;
  mode: (typeof PLATFORM_AGENT_ASSIGNMENT_MODES)[number];
  pinnedVersionId: string | null;
  targetId: string;
  targetType: (typeof PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES)[number];
  versionPolicy: (typeof PLATFORM_AGENT_VERSION_POLICIES)[number];
};

/**
 * Shared assignment shape fields (without identity / CAS / reason).
 * Used by upsert, preview, and output projections.
 *
 * `pinnedVersionId` / `versionPolicy` stay on the wire for older clients. Platform agents have
 * no version management: every write follows the latest published version, so those fields are
 * accepted then ignored (canonicalized to `latest_published` + `null`).
 */
export const PLATFORM_AGENT_ASSIGNMENT_LATEST_PUBLISHED = {
  pinnedVersionId: null,
  versionPolicy: 'latest_published',
} as const satisfies Pick<PlatformAgentAssignmentCore, 'pinnedVersionId' | 'versionPolicy'>;

export const withLatestPublishedAssignmentVersion = <T extends object>(
  assignment: T,
): T & typeof PLATFORM_AGENT_ASSIGNMENT_LATEST_PUBLISHED => ({
  ...assignment,
  ...PLATFORM_AGENT_ASSIGNMENT_LATEST_PUBLISHED,
});

export const platformAgentAssignmentCoreFields = {
  enabled: z.boolean(),
  mode: z.enum(PLATFORM_AGENT_ASSIGNMENT_MODES),
  pinnedVersionId: idSchema.nullable(),
  targetId: idSchema,
  targetType: z.enum(PLATFORM_AGENT_ASSIGNMENT_TARGET_TYPES),
  versionPolicy: z.enum(PLATFORM_AGENT_VERSION_POLICIES),
} as const;

/** Global target pairing + pinned-version pairing — single source of truth. */
export const refinePlatformAgentAssignmentInvariants = (
  assignment: Pick<
    PlatformAgentAssignmentCore,
    'pinnedVersionId' | 'targetId' | 'targetType' | 'versionPolicy'
  >,
  ctx: z.RefinementCtx,
): void => {
  if (
    (assignment.targetType === 'global') !==
    (assignment.targetId === PLATFORM_AGENT_GLOBAL_TARGET_ID)
  ) {
    ctx.addIssue({ code: 'custom', message: 'global assignment target is invalid' });
  }
  if ((assignment.versionPolicy === 'pinned') !== (assignment.pinnedVersionId !== null)) {
    ctx.addIssue({ code: 'custom', message: 'pinned policy requires exactly one version' });
  }
};

export const platformAgentAssignmentCoreSchema = z
  .object(platformAgentAssignmentCoreFields)
  .strict()
  .superRefine(refinePlatformAgentAssignmentInvariants)
  .transform(withLatestPublishedAssignmentVersion);
