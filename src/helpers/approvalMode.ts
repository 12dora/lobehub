import {
  resolveTopicApprovalMode,
  type RuntimeApprovalMode,
  type TopicApprovalMode,
} from '@lobechat/types';

import { isPlatformSettingLocked } from '@/helpers/platformSettingLocks';
import { toolInterventionSelectors } from '@/store/user/selectors';
import { type ApprovalMode } from '@/store/user/slices/settings/selectors';
import { getUserStoreState } from '@/store/user/store';

export const APPROVAL_MODE_SETTING_PATH = 'tool.humanIntervention.approvalMode';

/**
 * Map a runtime mode onto the user-selectable set. `headless` is an internal
 * (CLI / async / org) mode with no menu entry — the UI and the runtime payload
 * have always presented it as auto-run, so keep that mapping in one place.
 */
export const toSelectableApprovalMode = (mode: RuntimeApprovalMode): ApprovalMode =>
  mode === 'headless' ? 'auto-run' : mode;

/**
 * Effective tool-approval mode for a conversation, outside React.
 *
 * Mirrors the server chain in `resolveEffectiveUserInterventionConfig`:
 * platform-locked → topic snapshot → user preference. The user-store value is
 * already the *server-resolved effective* setting (`user.getUserState` runs it
 * through `loadEffectiveUserSettings`), so it doubles as both the user
 * preference and the locked/platform-default value.
 *
 * React surfaces should call `resolveTopicApprovalMode` directly with
 * `usePlatformSettingMeta(...).locked`, which is reactive; this helper reads the
 * published lock mirror for store/transport callers that cannot use hooks.
 */
export const getEffectiveApprovalMode = (
  topicApprovalMode?: TopicApprovalMode | null,
): RuntimeApprovalMode => {
  const userApprovalMode = toolInterventionSelectors.rawApprovalMode(getUserStoreState());
  const platformLocked = isPlatformSettingLocked(APPROVAL_MODE_SETTING_PATH);

  return resolveTopicApprovalMode({
    lockedValue: userApprovalMode,
    platformLocked,
    topicApprovalMode,
    userApprovalMode,
  });
};
