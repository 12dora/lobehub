import type {
  ExactPlatformAgentVersion,
  PlatformAgentAssignmentSafeItem,
} from '@/database/repositories/platformAgentCatalog';
import {
  acquirePlatformAgentReferenceLock,
  PlatformAgentCatalogRepository,
} from '@/database/repositories/platformAgentCatalog';
import type { PlatformAgentItem } from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import { PlatformAgentRevisionConflictError } from './errors';
import type { PlatformAgentRolloutJobInput } from './rolloutService';

export const isRolloutIdentityCurrent = (
  identity: Pick<PlatformAgentItem, 'migrationRequired' | 'status' | 'systemKey'>,
): boolean => {
  if (identity.status !== 'published') return false;
  if (identity.migrationRequired) return false;
  if (identity.systemKey === 'default-inbox') return false;
  return true;
};

export const assignmentMatchesSnapshot = (
  assignment: PlatformAgentAssignmentSafeItem,
  snapshot: PlatformAgentRolloutJobInput['snapshot'],
  identity: Pick<PlatformAgentItem, 'currentVersionId'>,
): boolean => {
  if (!assignment.enabled) return false;
  if (assignment.status !== 'active') return false;
  if (assignment.targetType !== snapshot.targetType) return false;
  if (assignment.targetId !== snapshot.targetId) return false;
  if (assignment.versionPolicy !== snapshot.versionPolicy) return false;
  if (
    snapshot.versionPolicy === 'pinned' &&
    assignment.pinnedVersionId !== snapshot.targetVersionId
  )
    return false;
  if (
    snapshot.versionPolicy === 'latest_published' &&
    identity.currentVersionId !== snapshot.targetVersionId
  )
    return false;
  return true;
};

export const versionMatchesSnapshot = (
  version: Pick<ExactPlatformAgentVersion, 'checksum'>,
  snapshot: Pick<PlatformAgentRolloutJobInput['snapshot'], 'targetVersionChecksum'>,
): boolean => version.checksum === snapshot.targetVersionChecksum;

export const validateSnapshot = async (tx: Transaction, input: PlatformAgentRolloutJobInput) => {
  const repository = new PlatformAgentCatalogRepository(tx);
  const { snapshot } = input;
  await acquirePlatformAgentReferenceLock(tx, snapshot.agentId);
  const identity = await repository.lockIdentity(snapshot.agentId);
  if (!identity || !isRolloutIdentityCurrent(identity)) {
    throw new PlatformAgentRevisionConflictError();
  }
  const assignment = await repository.getAssignment(snapshot.agentId, snapshot.assignmentId);
  if (!assignment || !assignmentMatchesSnapshot(assignment, snapshot, identity)) {
    throw new PlatformAgentRevisionConflictError();
  }
  const version = await repository.getExactVersion(snapshot.agentId, snapshot.targetVersionId);
  if (!version || !versionMatchesSnapshot(version, snapshot)) {
    throw new PlatformAgentRevisionConflictError();
  }
  return repository;
};
