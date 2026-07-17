export interface UserSettingsWithMarketToken {
  market?: { accessToken?: string };
}

/** Device routing state captured from the resolved run plan. */
export interface SkillDeviceExecution {
  deviceId: string;
  executionTimeoutMs?: number;
  operationId?: string;
  projectSkills?: { location: string; name: string }[];
  resolveWorkspaceId: () => Promise<string | undefined>;
  workingDirectory?: string;
}

export interface ActivatedSkillArchive {
  name: string;
  url: string;
  zipHash: string;
}
