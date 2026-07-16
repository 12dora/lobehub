import type { UserInterventionConfig } from '@lobechat/types';

import { type UserStore } from '@/store/user';

import { currentSettings } from './settings';

/**
 * User-selectable approval modes (excludes 'headless' which is for backend async tasks only)
 */
export type ApprovalMode = 'auto-run' | 'allow-list' | 'manual';
export type RawApprovalMode = UserInterventionConfig['approvalMode'];

export const USER_SELECTABLE_APPROVAL_MODES = [
  'auto-run',
  'allow-list',
  'manual',
] as const satisfies readonly ApprovalMode[];

const humanInterventionConfig = (s: UserStore) => currentSettings(s).tool?.humanIntervention || {};

const rawInterventionApprovalMode = (s: UserStore): RawApprovalMode =>
  currentSettings(s).tool?.humanIntervention?.approvalMode || 'manual';

const interventionApprovalMode = (s: UserStore): ApprovalMode => {
  const mode = rawInterventionApprovalMode(s);
  // Filter out 'headless' mode as it's not user-selectable (fallback to auto-run as similar behavior)
  if (mode === 'headless') return 'auto-run';
  return mode || 'manual';
};

const interventionAllowList = (s: UserStore) =>
  currentSettings(s).tool?.humanIntervention?.allowList || [];

export const toolInterventionSelectors = {
  allowList: interventionAllowList,
  approvalMode: interventionApprovalMode,
  config: humanInterventionConfig,
  rawApprovalMode: rawInterventionApprovalMode,
};
