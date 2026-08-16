import type { ModelRuntime } from '@lobechat/model-runtime';

import type {
  ModerationCategory,
  ModerationEffectiveAction,
  ModerationRequestKind,
} from '@/const/platform/contentModeration';
import type { LobeChatDatabase } from '@/database/type';
import type { ContentModerationConfig } from '@/types/platform/contentModeration';

export interface WrapModelRuntimeContext {
  db: LobeChatDatabase;
  provider: string;
  skipModeration?: boolean;
  userId: string;
  workspaceId?: string;
}

export interface ModerationEvaluateInput {
  messageId?: string;
  model: string;
  provider: string;
  requestId?: string;
  requestKind: ModerationRequestKind;
  text: string;
  topicId?: string;
  userId: string;
}

export interface ModerationDecisionSkipped {
  reason?: string;
  skipped: true;
}

export interface ModerationDowngradeTarget {
  model: string;
  provider: string;
}

export interface ModerationDecisionEvaluated {
  downgradeTarget?: ModerationDowngradeTarget | null;
  effectiveAction: ModerationEffectiveAction;
  /**
   * Classifier outage with `onError === 'block'` in enforce mode. User-facing
   * 403, but `effectiveAction` stays `'error'` so it is not a violation.
   */
  enforce?: boolean;
  error?: string;
  hash?: string;
  latencyMs?: number;
  matchedRule?: { id: string; isRegex?: boolean; pattern: string };
  policyAction?: string;
  recordId?: string;
  reused?: boolean;
  scores?: Record<string, number>;
  skipped: false;
  source?: string;
  thresholdSnapshot?: unknown;
  topCategory?: ModerationCategory | string | null;
  topScore?: number | null;
}

export type ModerationDecision = ModerationDecisionSkipped | ModerationDecisionEvaluated;

export interface ModerationSnapshotMessages {
  blockMessage?: string;
  downgradeMessage?: string;
  showCategoryToUser?: boolean;
}

export interface ModerationSnapshot {
  config?: {
    downgrade?: ModerationDowngradeTarget | null;
    messages?: ModerationSnapshotMessages;
    mode?: 'off' | 'observe' | 'enforce';
  };
  skipped?: boolean;
}

export interface ModerationRecordContext {
  config?: ContentModerationConfig;
  effectiveModel?: string;
  effectiveProvider?: string;
  messageId?: string;
  model: string;
  provider: string;
  recordId: string;
  requestId?: string;
  requestKind: ModerationRequestKind;
  text?: string;
  topicId?: string;
  userId: string;
}

export interface ModerationRuntimeLogger {
  debug?: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

export interface ModerationRuntimeDeps {
  createRecordId?: () => string;
  evaluate: (db: LobeChatDatabase, input: ModerationEvaluateInput) => Promise<ModerationDecision>;
  extractGenerationPrompt?: (payload: unknown) => string | null;
  extractPromptText?: (payload: unknown) => string | null;
  getSnapshot?: (db: LobeChatDatabase) => Promise<ModerationSnapshot | null | undefined>;
  initRuntime: (provider: string) => Promise<ModelRuntime>;
  logger?: ModerationRuntimeLogger;
  now?: () => Date;
  persistDowngrade?: (marker: ModerationDowngradeMarker, messageId: string) => void | Promise<void>;
  record: (
    db: LobeChatDatabase,
    ctx: ModerationRecordContext,
    decision: ModerationDecision,
  ) => void | Promise<void>;
}

export interface ModerationDowngradeMarker {
  action: 'downgrade';
  category?: string;
  /** Admin-configured `downgradeMessage` (raw; header is encodeURIComponent'd). */
  message?: string;
  model: string;
  originalModel: string;
  originalProvider: string;
  provider: string;
  recordId?: string;
}

export const MODERATION_DOWNGRADE_OPTION_KEY = '__lobeModerationDowngrade';
