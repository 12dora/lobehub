import type { ContentModerationSettingsView } from '@/types/platform/contentModeration';

/** Config half of the settings view (masked API keys, no revision metadata). */
export type ModerationConfigView = Omit<
  ContentModerationSettingsView,
  'revision' | 'updatedAt' | 'updatedBy'
>;

export interface ModerationSettingsDraft {
  /**
   * Plaintext Moderations API keys typed in this session. They are sent once on save and
   * never round-trip: the server returns fingerprints + masks only.
   */
  addedApiKeys: string[];
  config: ModerationConfigView;
}

export interface DraftIssue {
  /** i18n key under `admin` → `contentModeration.errors.*`. */
  key: string;
  params?: Record<string, string | number>;
}
