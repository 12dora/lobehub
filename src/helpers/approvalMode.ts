import {
  isTopicApprovalMode,
  resolveTopicApprovalMode,
  type RuntimeApprovalMode,
  type TopicApprovalMode,
} from '@lobechat/types';

import {
  isPlatformSettingLocked,
  isPlatformSettingLockUnknown,
} from '@/helpers/platformSettingLocks';
import { toolInterventionSelectors } from '@/store/user/selectors';
import { type ApprovalMode } from '@/store/user/slices/settings/selectors';
import { getUserStoreState } from '@/store/user/store';

export const APPROVAL_MODE_SETTING_PATH = 'tool.humanIntervention.approvalMode';

/**
 * Safest mode to run under when a managed policy could apply but its lock state
 * is not known yet: every tool call goes through the user.
 */
export const SAFE_APPROVAL_MODE: TopicApprovalMode = 'manual';

/**
 * Map a runtime mode onto the user-selectable set. `headless` is an internal
 * (CLI / async / org) mode with no menu entry, so the *picker* presents it as
 * auto-run.
 *
 * Presentation only — never apply this to a runtime payload: headless and
 * auto-run differ in how blocked tools are handled (headless skips them, auto-run
 * can park on `human_intervention_required`).
 */
export const toSelectableApprovalMode = (mode: RuntimeApprovalMode): ApprovalMode =>
  mode === 'headless' ? 'auto-run' : mode;

/**
 * The value to snapshot onto a topic: `headless` is never stored (the server
 * leaves headless runs unsnapshotted too), so it yields `undefined` and the
 * caller must omit `approvalMode` entirely.
 */
export const toTopicApprovalSnapshot = (
  mode: RuntimeApprovalMode,
): TopicApprovalMode | undefined => (isTopicApprovalMode(mode) ? mode : undefined);

/**
 * Effective tool-approval mode for a conversation, outside React.
 *
 * Mirrors the server chain in `resolveEffectiveUserInterventionConfig`:
 * platform-locked → topic snapshot → user preference. The user-store value is
 * already the *server-resolved effective* setting (`user.getUserState` runs it
 * through `loadEffectiveUserSettings`), so it doubles as both the user
 * preference and the locked/platform-default value.
 *
 * Fails closed: while the platform lock mirror is `unknown` (bootstrap in
 * flight, fetch failed, account just switched) a managed policy might be
 * locking this path, so neither the topic snapshot nor the local preference can
 * be trusted and the safe `manual` mode is used instead.
 *
 * React surfaces should call `resolveTopicApprovalMode` directly with
 * `usePlatformSettingMeta(...).locked`, which is reactive; this helper reads the
 * published lock mirror for store/transport callers that cannot use hooks.
 */
export const getEffectiveApprovalMode = (
  topicApprovalMode?: TopicApprovalMode | null,
): RuntimeApprovalMode => {
  if (isPlatformSettingLockUnknown()) return SAFE_APPROVAL_MODE;

  const userApprovalMode = toolInterventionSelectors.rawApprovalMode(getUserStoreState());
  const platformLocked = isPlatformSettingLocked(APPROVAL_MODE_SETTING_PATH);

  return resolveTopicApprovalMode({
    lockedValue: userApprovalMode,
    platformLocked,
    topicApprovalMode,
    userApprovalMode,
  });
};
